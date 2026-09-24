import { PublicKey } from "@solana/web3.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import type { ConfigAccount } from "@launchpad/sdk";

import type { Db, TokenSort, TokenStatusFilter } from "../db/db.js";
import type { EventBus, LiveEvent } from "../indexer/bus.js";
import { buildMetadataJson, sniffImageType, type Storage } from "../metadata/storage.js";
import { RateLimiter } from "./rate-limit.js";

export interface AppDeps {
  db: Db;
  bus: EventBus;
  storage: Storage;
  /** Reads the on-chain config (the caller is responsible for caching). */
  getConfig?: () => Promise<ConfigAccount>;
  corsOrigin?: string;
  maxImageBytes?: number;
  /** Value of `createdOn` in generated metadata. */
  siteUrl?: string;
  /** Uploads allowed per IP and minute. */
  uploadsPerMinute?: number;
  /** Client IP used for rate limiting (default: proxy headers, then "local"). */
  clientIp?: (c: Context) => string;
}

/** Client IP from proxy headers. Only trustworthy behind a proxy that sets them. */
export const ipFromHeaders = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";

const SORTS: TokenSort[] = ["new", "market_cap", "last_trade", "trending", "progress"];
const STATUSES: TokenStatusFilter[] = ["trading", "complete", "migrated"];
const INTERVALS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};

const isPubkey = (value: string): boolean => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

const intParam = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const badRequest = (c: Context, message: string) => c.json({ error: message }, 400);

export function serializeConfig(config: ConfigAccount) {
  return {
    admin: config.admin.toBase58(),
    feeRecipient: config.feeRecipient.toBase58(),
    initialVirtualSolReserves: config.initialVirtualSolReserves.toString(),
    initialVirtualTokenReserves: config.initialVirtualTokenReserves.toString(),
    initialRealTokenReserves: config.initialRealTokenReserves.toString(),
    tokenTotalSupply: config.tokenTotalSupply.toString(),
    protocolFeeBps: config.protocolFeeBps,
    creatorFeeBps: config.creatorFeeBps,
    creationFeeLamports: config.creationFeeLamports.toString(),
    migrationFeeLamports: config.migrationFeeLamports.toString(),
    raydium: {
      cpmmProgram: config.raydium.cpmmProgram.toBase58(),
      ammConfig: config.raydium.ammConfig.toBase58(),
      createPoolFee: config.raydium.createPoolFee.toBase58(),
    },
    createPaused: config.createPaused,
    tradingPaused: config.tradingPaused,
  };
}

export function createApp(deps: AppDeps): Hono {
  const { db, bus, storage } = deps;
  const maxImageBytes = deps.maxImageBytes ?? 5 * 1024 * 1024;
  const uploads = new RateLimiter(deps.uploadsPerMinute ?? 10, 60_000);
  const app = new Hono();

  app.use("*", cors({ origin: deps.corsOrigin ?? "*" }));
  app.onError((err, c) => {
    console.error("[api]", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, cursor: db.getMeta("indexer.cursor") }));

  app.get("/api/config", async (c) => {
    if (!deps.getConfig) return c.json({ error: "config unavailable" }, 503);
    return c.json(serializeConfig(await deps.getConfig()));
  });

  app.get("/api/stats", (c) => c.json(db.stats()));

  // ---------------------------------------------------------------- tokens

  app.get("/api/tokens", (c) => {
    const sort = (c.req.query("sort") ?? "new") as TokenSort;
    const status = c.req.query("status") as TokenStatusFilter | undefined;
    const creator = c.req.query("creator");
    if (!SORTS.includes(sort)) return badRequest(c, `sort must be one of ${SORTS.join(", ")}`);
    if (status && !STATUSES.includes(status)) return badRequest(c, `status must be one of ${STATUSES.join(", ")}`);
    if (creator && !isPubkey(creator)) return badRequest(c, "invalid creator");
    const search = c.req.query("q")?.trim().slice(0, 64) || undefined;
    const limit = intParam(c.req.query("limit"), 50);
    const offset = intParam(c.req.query("offset"), 0);
    return c.json({ tokens: db.listTokens({ sort, status, creator, search, limit, offset }) });
  });

  app.get("/api/tokens/:mint", (c) => {
    const mint = c.req.param("mint");
    if (!isPubkey(mint)) return badRequest(c, "invalid mint");
    const token = db.getToken(mint);
    if (!token) return c.json({ error: "token not found" }, 404);
    return c.json({ token, graduation: db.getGraduation(mint) });
  });

  app.get("/api/tokens/:mint/trades", (c) => {
    const mint = c.req.param("mint");
    if (!isPubkey(mint)) return badRequest(c, "invalid mint");
    const before = c.req.query("before");
    return c.json({
      trades: db.listTrades({
        mint,
        limit: intParam(c.req.query("limit"), 50),
        beforeId: before ? intParam(before, 0) : undefined,
      }),
    });
  });

  app.get("/api/tokens/:mint/candles", (c) => {
    const mint = c.req.param("mint");
    if (!isPubkey(mint)) return badRequest(c, "invalid mint");
    const interval = INTERVALS[c.req.query("interval") ?? "5m"];
    if (!interval) return badRequest(c, `interval must be one of ${Object.keys(INTERVALS).join(", ")}`);
    const now = Math.floor(Date.now() / 1000);
    const to = intParam(c.req.query("to"), now);
    const from = intParam(c.req.query("from"), to - interval * 500);
    if (from > to) return badRequest(c, "from must be before to");
    if ((to - from) / interval > 5_000) return badRequest(c, "range too large for this interval");
    return c.json({ interval, candles: db.candles(mint, interval, from, to) });
  });

  // ----------------------------------------------------------------- users

  app.get("/api/users/:wallet/trades", (c) => {
    const wallet = c.req.param("wallet");
    if (!isPubkey(wallet)) return badRequest(c, "invalid wallet");
    const before = c.req.query("before");
    return c.json({
      trades: db.listTrades({
        trader: wallet,
        limit: intParam(c.req.query("limit"), 50),
        beforeId: before ? intParam(before, 0) : undefined,
      }),
    });
  });

  app.get("/api/users/:wallet/tokens", (c) => {
    const wallet = c.req.param("wallet");
    if (!isPubkey(wallet)) return badRequest(c, "invalid wallet");
    return c.json({ tokens: db.listTokens({ creator: wallet, limit: intParam(c.req.query("limit"), 50) }) });
  });

  // -------------------------------------------------------------- live feed

  app.get("/api/stream", (c) => {
    const mint = c.req.query("mint");
    if (mint && !isPubkey(mint)) return badRequest(c, "invalid mint");
    return streamSSE(c, async (stream) => {
      const queue: LiveEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const unsubscribe = bus.subscribe((event) => {
        if (mint && event.mint !== mint) return;
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!closed) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        const woke = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        wake = null;
        if (!woke && !closed) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });

  // ------------------------------------------------------ metadata upload

  app.post(
    "/api/metadata",
    bodyLimit({ maxSize: maxImageBytes + 64 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }),
    async (c) => {
      const ip = (deps.clientIp ?? ipFromHeaders)(c);
      if (!uploads.take(ip)) return c.json({ error: "too many uploads, retry in a minute" }, 429);

      const body = await c.req.parseBody();
      const field = (key: string, max: number): string | undefined => {
        const value = body[key];
        if (typeof value !== "string") return undefined;
        const trimmed = value.trim();
        return trimmed ? trimmed.slice(0, max) : undefined;
      };
      const name = field("name", 64);
      const symbol = field("symbol", 16);
      if (!name || Buffer.byteLength(name) > 32) return badRequest(c, "name is required (max 32 bytes)");
      if (!symbol || Buffer.byteLength(symbol) > 10) return badRequest(c, "symbol is required (max 10 bytes)");

      const socials: Record<string, string | undefined> = {};
      for (const key of ["twitter", "telegram", "website"] as const) {
        const value = field(key, 200);
        if (value && !/^https:\/\/[^\s]+$/i.test(value)) return badRequest(c, `${key} must be an https URL`);
        socials[key] = value;
      }

      const image = body.image;
      if (!(image instanceof File)) return badRequest(c, "image file is required");
      if (image.size > maxImageBytes) return c.json({ error: "image too large" }, 413);
      const bytes = new Uint8Array(await image.arrayBuffer());
      const contentType = sniffImageType(bytes);
      if (!contentType) return badRequest(c, "image must be png, jpeg, gif or webp");

      const storedImage = await storage.put(bytes, contentType, image.name || "image");
      const metadata = buildMetadataJson(
        { name, symbol, description: field("description", 1_000), ...socials },
        storedImage.url,
        deps.siteUrl ?? "",
      );
      const json = new TextEncoder().encode(JSON.stringify(metadata));
      const storedJson = await storage.put(json, "application/json", `${symbol}.json`);
      const uri = storedJson.url;
      if (Buffer.byteLength(uri) > 200) return c.json({ error: "storage returned a URI longer than 200 bytes" }, 500);
      return c.json({ uri, image: storedImage.url, metadata });
    },
  );

  return app;
}
