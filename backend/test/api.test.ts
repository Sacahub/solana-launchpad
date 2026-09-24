import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MigratedEvent, TokenCreatedEvent, TradeEvent } from "@launchpad/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/api/app.js";
import { Db } from "../src/db/db.js";
import { EventBus } from "../src/indexer/bus.js";
import { applyEvent } from "../src/indexer/indexer.js";
import { LocalStorage } from "../src/metadata/storage.js";

const UNIT = 1_000_000n;
const SOL = 1_000_000_000n;
const T0 = 1_790_000_000;

let db: Db;
let bus: EventBus;
let uploadDir: string;
let app: ReturnType<typeof createApp>;
let sigCounter = 0;

const key = () => Keypair.generate().publicKey;
const ctx = (slot: number, blockTime = T0, eventIndex = 0) => ({
  signature: `sig${++sigCounter}`,
  slot,
  blockTime,
  eventIndex,
});

function created(mint: PublicKey, creator: PublicKey, name = "Moon Cat", timestamp = T0): TokenCreatedEvent {
  return {
    mint,
    bondingCurve: key(),
    creator,
    name,
    symbol: name.slice(0, 4).toUpperCase(),
    uri: "https://example.com/m.json",
    virtualSolReserves: 30n * SOL,
    virtualTokenReserves: 1_073_000_000n * UNIT,
    realTokenReserves: 793_100_000n * UNIT,
    tokenTotalSupply: 1_000_000_000n * UNIT,
    timestamp,
  };
}

/** Builds a buy/sell event consistent with a constant product curve state. */
function trade(
  state: { vs: bigint; vt: bigint },
  mint: PublicKey,
  isBuy: boolean,
  sol: bigint,
  timestamp: number,
  trader = key(),
): TradeEvent {
  const tokens = isBuy ? (state.vt * sol) / (state.vs + sol) : (state.vt * sol) / (state.vs - sol);
  state.vs = isBuy ? state.vs + sol : state.vs - sol;
  state.vt = isBuy ? state.vt - tokens : state.vt + tokens;
  return {
    mint,
    trader,
    isBuy,
    solAmount: sol,
    tokenAmount: tokens,
    protocolFee: sol / 100n,
    creatorFee: sol / 200n,
    virtualSolReserves: state.vs,
    virtualTokenReserves: state.vt,
    realSolReserves: state.vs - 30n * SOL,
    realTokenReserves: state.vt - (1_073_000_000n - 793_100_000n) * UNIT,
    timestamp,
  };
}

beforeEach(() => {
  db = new Db(":memory:");
  bus = new EventBus();
  uploadDir = mkdtempSync(join(tmpdir(), "launchpad-uploads-"));
  app = createApp({
    db,
    bus,
    storage: new LocalStorage(uploadDir, "http://localhost:8787"),
    uploadsPerMinute: 3,
    siteUrl: "http://localhost:8787",
  });
});

afterEach(() => {
  db.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe("indexing and token API", () => {
  it("lists tokens and tracks trades, price, progress and volume", async () => {
    const mint = key();
    const creator = key();
    applyEvent(db, { name: "tokenCreated", data: created(mint, creator) }, ctx(1));

    const state = { vs: 30n * SOL, vt: 1_073_000_000n * UNIT };
    const buy1 = trade(state, mint, true, 2n * SOL, T0 + 10);
    const buy2 = trade(state, mint, true, 3n * SOL, T0 + 20);
    const sell = trade(state, mint, false, SOL, T0 + 70);
    applyEvent(db, { name: "trade", data: buy1 }, ctx(2, T0 + 10));
    applyEvent(db, { name: "trade", data: buy2 }, ctx(3, T0 + 20));
    const sellCtx = ctx(4, T0 + 70);
    applyEvent(db, { name: "trade", data: sell }, sellCtx);
    // Re-processing the same event is a no-op.
    expect(applyEvent(db, { name: "trade", data: sell }, sellCtx)).toBeNull();

    const res = await app.request("/api/tokens");
    expect(res.status).toBe(200);
    const { tokens } = (await res.json()) as { tokens: Record<string, unknown>[] };
    expect(tokens).toHaveLength(1);
    const t = tokens[0];
    expect(t.mint).toBe(mint.toBase58());
    expect(t.tradeCount).toBe(3);
    expect(t.volumeSol).toBe((6n * SOL).toString());
    expect(t.realSolReserves).toBe((4n * SOL).toString());
    expect(t.lastTradeAt).toBe(T0 + 70);
    expect(t.progress as number).toBeGreaterThan(0);
    expect(t.priceSol as number).toBeCloseTo(Number(state.vs) / Number(state.vt) / 1000, 15);
    expect(t.marketCapSol as number).toBeCloseTo((t.priceSol as number) * 1e9, 6);

    const detail = await (await app.request(`/api/tokens/${mint.toBase58()}`)).json();
    expect(detail.token.name).toBe("Moon Cat");
    expect(detail.graduation).toBeNull();

    const trades = await (await app.request(`/api/tokens/${mint.toBase58()}/trades?limit=2`)).json();
    expect(trades.trades).toHaveLength(2);
    expect(trades.trades[0].isBuy).toBe(false); // newest first
    const older = await (
      await app.request(`/api/tokens/${mint.toBase58()}/trades?before=${trades.trades[1].id}`)
    ).json();
    expect(older.trades).toHaveLength(1);
    expect(older.trades[0].solAmount).toBe((2n * SOL).toString());

    const byTrader = await (await app.request(`/api/users/${buy1.trader.toBase58()}/trades`)).json();
    expect(byTrader.trades).toHaveLength(1);
    const byCreator = await (await app.request(`/api/users/${creator.toBase58()}/tokens`)).json();
    expect(byCreator.tokens).toHaveLength(1);
  });

  it("aggregates OHLCV candles in chain order", async () => {
    const mint = key();
    applyEvent(db, { name: "tokenCreated", data: created(mint, key()) }, ctx(1));
    const state = { vs: 30n * SOL, vt: 1_073_000_000n * UNIT };
    const base = Math.floor(T0 / 60) * 60;
    const events = [
      trade(state, mint, true, SOL, base), // bucket 0
      trade(state, mint, true, 2n * SOL, base + 30), // bucket 0
      trade(state, mint, false, SOL, base + 45), // bucket 0
      trade(state, mint, true, SOL, base + 61), // bucket 1
    ];
    events.forEach((e, i) => applyEvent(db, { name: "trade", data: e }, ctx(10 + i, e.timestamp)));

    const res = await app.request(
      `/api/tokens/${mint.toBase58()}/candles?interval=1m&from=${T0 - 60}&to=${T0 + 3600}`,
    );
    const { candles } = (await res.json()) as {
      candles: { time: number; open: number; high: number; low: number; close: number; volume: string; trades: number }[];
    };
    const price = (e: TradeEvent) => Number(e.solAmount) / 1e9 / (Number(e.tokenAmount) / 1e6);
    const bucket0 = base;
    expect(candles).toHaveLength(2);
    expect(candles[0].time).toBe(bucket0);
    expect(candles[0].open).toBeCloseTo(price(events[0]), 15);
    expect(candles[0].close).toBeCloseTo(price(events[2]), 15);
    expect(candles[0].high).toBeCloseTo(Math.max(...events.slice(0, 3).map(price)), 15);
    expect(candles[0].low).toBeCloseTo(Math.min(...events.slice(0, 3).map(price)), 15);
    expect(candles[0].volume).toBe((4n * SOL).toString());
    expect(candles[0].trades).toBe(3);
    expect(candles[1].time).toBe(bucket0 + 60);
    expect(candles[1].trades).toBe(1);
  });

  it("tracks completion and graduation", async () => {
    const mint = key();
    applyEvent(db, { name: "tokenCreated", data: created(mint, key()) }, ctx(1));
    applyEvent(
      db,
      {
        name: "curveCompleted",
        data: { mint, realSolReserves: 85n * SOL, virtualSolReserves: 115n * SOL, virtualTokenReserves: 279_900_000n * UNIT, timestamp: T0 + 5 },
      },
      ctx(2),
    );
    expect(db.getToken(mint.toBase58())!.status).toBe("complete");

    // A stuck curve reopened after the migration timeout, then completed again.
    applyEvent(db, { name: "curveReopened", data: { mint, timestamp: T0 + 7 } }, ctx(2));
    expect(db.getToken(mint.toBase58())).toMatchObject({ status: "trading", completedAt: null });
    applyEvent(
      db,
      {
        name: "curveCompleted",
        data: { mint, realSolReserves: 85n * SOL, virtualSolReserves: 115n * SOL, virtualTokenReserves: 279_900_000n * UNIT, timestamp: T0 + 8 },
      },
      ctx(2),
    );
    expect(db.getToken(mint.toBase58())!.status).toBe("complete");

    const migrated: MigratedEvent = {
      mint,
      pool: key(),
      lpMint: key(),
      poolSolAmount: 84n * SOL,
      poolTokenAmount: 200_000_000n * UNIT,
      burnedTokenAmount: 6_900_000n * UNIT,
      burnedLpAmount: 123n,
      protocolAmount: SOL,
      timestamp: T0 + 9,
    };
    applyEvent(db, { name: "migrated", data: migrated }, ctx(3));
    const detail = await (await app.request(`/api/tokens/${mint.toBase58()}`)).json();
    expect(detail.token.status).toBe("migrated");
    expect(detail.token.raydiumPool).toBe(migrated.pool.toBase58());
    expect(detail.token.tokenTotalSupply).toBe((993_100_000n * UNIT).toString());
    expect(detail.graduation.pool).toBe(migrated.pool.toBase58());

    const stats = await (await app.request("/api/stats")).json();
    expect(stats).toMatchObject({ tokens: 1, migrated: 1, trading: 0 });
    const filtered = await (await app.request("/api/tokens?status=migrated")).json();
    expect(filtered.tokens).toHaveLength(1);
    const none = await (await app.request("/api/tokens?status=trading")).json();
    expect(none.tokens).toHaveLength(0);
  });

  it("sorts, searches and validates input", async () => {
    const creator = key();
    const a = key();
    const b = key();
    applyEvent(db, { name: "tokenCreated", data: created(a, creator, "Alpha 100%", T0) }, ctx(1));
    applyEvent(db, { name: "tokenCreated", data: created(b, creator, "Beta", T0 + 1) }, ctx(2));
    const state = { vs: 30n * SOL, vt: 1_073_000_000n * UNIT };
    applyEvent(db, { name: "trade", data: trade(state, a, true, 10n * SOL, T0 + 2) }, ctx(3));

    const names = async (q: string) =>
      ((await (await app.request(`/api/tokens?${q}`)).json()) as { tokens: { name: string }[] }).tokens.map((t) => t.name);
    expect(await names("sort=new")).toEqual(["Beta", "Alpha 100%"]);
    expect(await names("sort=market_cap")).toEqual(["Alpha 100%", "Beta"]);
    expect(await names(`sort=trending`)).toEqual(["Alpha 100%", "Beta"]);
    expect(await names("q=bet")).toEqual(["Beta"]);
    expect(await names("q=100%25")).toEqual(["Alpha 100%"]); // '%' is escaped in LIKE
    expect(await names("q=_")).toEqual([]);

    expect((await app.request("/api/tokens?sort=random")).status).toBe(400);
    expect((await app.request("/api/tokens?status=nope")).status).toBe(400);
    expect((await app.request("/api/tokens/not-a-key")).status).toBe(400);
    expect((await app.request(`/api/tokens/${key().toBase58()}`)).status).toBe(404);
    expect((await app.request(`/api/tokens/${a.toBase58()}/candles?interval=7m`)).status).toBe(400);
  });
});

describe("metadata upload", () => {
  const png = () =>
    new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], "logo.png", {
      type: "image/png",
    });

  const upload = (fields: Record<string, string | File>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return app.request("/api/metadata", { method: "POST", body: form, headers: { "x-real-ip": "1.2.3.4" } });
  };

  it("stores the image and the metadata JSON and returns the URI", async () => {
    const res = await upload({
      name: "Moon Cat",
      symbol: "MCAT",
      description: "to the moon",
      twitter: "https://x.com/mooncat",
      image: png(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; image: string; metadata: Record<string, unknown> };
    expect(body.uri).toMatch(/^http:\/\/localhost:8787\/files\/[a-f0-9]{64}\.json$/);
    expect(body.image).toMatch(/\.png$/);
    expect(body.metadata).toMatchObject({
      name: "Moon Cat",
      symbol: "MCAT",
      description: "to the moon",
      image: body.image,
      twitter: "https://x.com/mooncat",
    });
  });

  it("rejects invalid uploads and rate limits", async () => {
    const fake = new File([new TextEncoder().encode("<svg></svg>")], "x.png", { type: "image/png" });
    expect((await upload({ name: "A", symbol: "A", image: fake })).status).toBe(400);
    expect((await upload({ name: "A", symbol: "A" })).status).toBe(400);
    expect((await upload({ name: "", symbol: "A", image: png() })).status).toBe(400);
    // 4th request in the same minute from the same IP
    expect((await upload({ name: "A", symbol: "A", image: png() })).status).toBe(429);
  });

  it("rejects non-https socials", async () => {
    const res = await upload({ name: "A", symbol: "A", website: "javascript:alert(1)", image: png() });
    expect(res.status).toBe(400);
  });
});

describe("live stream", () => {
  it("pushes indexed events to SSE clients, filtered by mint", async () => {
    const mint = key();
    const res = await app.request(`/api/stream?mint=${mint.toBase58()}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil("event: ready");
    bus.publish({ type: "trade", mint: key().toBase58(), signature: "other", data: {} });
    bus.publish({ type: "trade", mint: mint.toBase58(), signature: "mine", data: { ok: true } });
    await readUntil('"signature":"mine"');
    expect(text).toContain("event: trade");
    expect(text).not.toContain('"signature":"other"');
    await reader.cancel();
  });
});
