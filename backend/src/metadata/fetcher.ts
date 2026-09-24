/**
 * Background worker resolving the off-chain metadata (image, description,
 * socials) of newly indexed tokens.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Db } from "../db/db.js";
import { safeFetchJson } from "./safe-fetch.js";

const MAX_BYTES = 256 * 1024;
const MAX_FIELD = 1_000;

export interface FetchedMetadata {
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/** Loads the JSON document behind a metadata URI. */
export type MetadataResolver = (uri: string) => Promise<unknown>;

/** Rewrites `ipfs://` and `ar://` URIs to public HTTP gateways. */
export function resolveUri(uri: string): string {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  if (uri.startsWith("ar://")) return `https://arweave.net/${uri.slice("ar://".length)}`;
  return uri;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_FIELD) : undefined;

const httpUrl = (value: unknown): string | undefined => {
  const t = text(value);
  if (!t) return undefined;
  const resolved = resolveUri(t);
  return /^https?:\/\//i.test(resolved) ? resolved : undefined;
};

export function parseMetadataJson(json: unknown): FetchedMetadata {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("metadata is not an object");
  const j = json as Record<string, unknown>;
  const ext = (j.extensions && typeof j.extensions === "object" ? j.extensions : {}) as Record<string, unknown>;
  return {
    description: text(j.description),
    image: httpUrl(j.image),
    twitter: httpUrl(j.twitter ?? ext.twitter),
    telegram: httpUrl(j.telegram ?? ext.telegram),
    website: httpUrl(j.website ?? ext.website),
  };
}

/**
 * Default resolver: files uploaded to this server's local storage are read
 * from disk, everything else goes through the SSRF-safe fetcher.
 */
export function createResolver(opts: {
  publicUrl: string;
  uploadDir: string;
  timeoutMs: number;
  allowHttp?: boolean;
}): MetadataResolver {
  const localPrefix = `${opts.publicUrl}/files/`;
  return async (uri) => {
    if (uri.startsWith(localPrefix)) {
      const file = uri.slice(localPrefix.length);
      if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error("invalid local file");
      return JSON.parse(await readFile(join(opts.uploadDir, file), "utf8"));
    }
    return safeFetchJson(resolveUri(uri), {
      timeoutMs: opts.timeoutMs,
      maxBytes: MAX_BYTES,
      allowHttp: opts.allowHttp,
    });
  };
}

export class MetadataWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly resolve: MetadataResolver,
    private readonly intervalMs = 3_000,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = this.db.tokensNeedingMetadata(10);
      await Promise.all(
        pending.map(async ({ mint, uri }) => {
          try {
            this.db.setMetadata(mint, parseMetadataJson(await this.resolve(uri)));
          } catch {
            this.db.metadataFailed(mint);
          }
        }),
      );
    } finally {
      this.busy = false;
    }
  }
}
