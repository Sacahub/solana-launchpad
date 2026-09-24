import { readFileSync } from "node:fs";

import { LAUNCHPAD_PROGRAM_ID } from "@launchpad/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";

export interface AppConfig {
  rpcUrl: string;
  wsUrl?: string;
  programId: PublicKey;
  databasePath: string;
  port: number;
  host: string;
  /** Base URL of this server, used to build URIs of locally stored files. */
  publicUrl: string;
  corsOrigin: string;
  indexer: {
    enabled: boolean;
    pollIntervalMs: number;
    /** Do not backfill transactions older than this signature. */
    startSignature?: string;
  };
  keeper: {
    enabled: boolean;
    keypair?: Keypair;
    intervalMs: number;
    /** Collect protocol fees of curves holding at least this many lamports (0 = off). */
    collectFeesMinLamports: bigint;
    priorityFeeMicroLamports: number;
  };
  storage: {
    driver: "local" | "pinata";
    uploadDir: string;
    pinataJwt?: string;
    pinataGateway: string;
    maxImageBytes: number;
  };
  metadataFetchTimeoutMs: number;
}

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase());

const int = (value: string | undefined, fallback: number) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${value}`);
  return n;
};

/** Accepts a path to a keypair file or the JSON array itself. */
export function parseKeypair(value: string): Keypair {
  const json = value.trim().startsWith("[") ? value : readFileSync(value, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = int(env.PORT, 8787);
  const driver = (env.STORAGE ?? "local") as "local" | "pinata";
  if (driver !== "local" && driver !== "pinata") throw new Error(`invalid STORAGE: ${driver}`);
  if (driver === "pinata" && !env.PINATA_JWT) throw new Error("STORAGE=pinata requires PINATA_JWT");

  const keeperEnabled = bool(env.KEEPER_ENABLED, false);
  if (keeperEnabled && !env.KEEPER_KEYPAIR) throw new Error("KEEPER_ENABLED requires KEEPER_KEYPAIR");

  return {
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8899",
    wsUrl: env.WS_URL || undefined,
    programId: env.PROGRAM_ID ? new PublicKey(env.PROGRAM_ID) : LAUNCHPAD_PROGRAM_ID,
    databasePath: env.DATABASE_PATH ?? "./data/launchpad.sqlite",
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    corsOrigin: env.CORS_ORIGIN ?? "*",
    indexer: {
      enabled: bool(env.INDEXER_ENABLED, true),
      pollIntervalMs: int(env.POLL_INTERVAL_MS, 2_000),
      startSignature: env.START_SIGNATURE || undefined,
    },
    keeper: {
      enabled: keeperEnabled,
      keypair: env.KEEPER_KEYPAIR ? parseKeypair(env.KEEPER_KEYPAIR) : undefined,
      intervalMs: int(env.KEEPER_INTERVAL_MS, 10_000),
      collectFeesMinLamports: BigInt(env.KEEPER_COLLECT_FEES_MIN_LAMPORTS ?? "0"),
      priorityFeeMicroLamports: int(env.KEEPER_PRIORITY_FEE_MICROLAMPORTS, 0),
    },
    storage: {
      driver,
      uploadDir: env.UPLOAD_DIR ?? "./data/uploads",
      pinataJwt: env.PINATA_JWT,
      pinataGateway: (env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud").replace(/\/$/, ""),
      maxImageBytes: int(env.MAX_IMAGE_BYTES, 5 * 1024 * 1024),
    },
    metadataFetchTimeoutMs: int(env.METADATA_FETCH_TIMEOUT_MS, 5_000),
  };
}
