import { mkdirSync } from "node:fs";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { LaunchpadClient, type ConfigAccount } from "@launchpad/sdk";
import { Connection } from "@solana/web3.js";
import { Hono } from "hono";

import { createApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { Db } from "./db/db.js";
import { EventBus } from "./indexer/bus.js";
import { Indexer } from "./indexer/indexer.js";
import { Keeper } from "./keeper.js";
import { MetadataWorker, createResolver } from "./metadata/fetcher.js";
import { LocalStorage, PinataStorage, type Storage } from "./metadata/storage.js";

const config = loadConfig();
const connection = new Connection(config.rpcUrl, { commitment: "confirmed", wsEndpoint: config.wsUrl });
const client = new LaunchpadClient(connection, { programId: config.programId });
const db = new Db(config.databasePath);
const bus = new EventBus();

const storage: Storage =
  config.storage.driver === "pinata"
    ? new PinataStorage(config.storage.pinataJwt!, config.storage.pinataGateway)
    : new LocalStorage(config.storage.uploadDir, config.publicUrl);

// On-chain config, cached for 30 seconds.
let cachedConfig: { value: ConfigAccount; at: number } | null = null;
const getConfig = async () => {
  if (!cachedConfig || Date.now() - cachedConfig.at > 30_000) {
    cachedConfig = { value: await client.fetchConfig(), at: Date.now() };
  }
  return cachedConfig.value;
};

const app = new Hono();
if (config.storage.driver === "local") {
  mkdirSync(config.storage.uploadDir, { recursive: true });
  app.use(
    "/files/*",
    serveStatic({
      root: config.storage.uploadDir,
      rewriteRequestPath: (path) => path.replace(/^\/files/, ""),
      onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  );
}
app.route(
  "/",
  createApp({
    db,
    bus,
    storage,
    getConfig,
    corsOrigin: config.corsOrigin,
    maxImageBytes: config.storage.maxImageBytes,
    siteUrl: config.publicUrl,
  }),
);

const indexer = new Indexer(connection, db, bus, {
  programId: config.programId,
  pollIntervalMs: config.indexer.pollIntervalMs,
  startSignature: config.indexer.startSignature,
});
const metadata = new MetadataWorker(
  db,
  createResolver({
    publicUrl: config.publicUrl,
    uploadDir: config.storage.uploadDir,
    timeoutMs: config.metadataFetchTimeoutMs,
    allowHttp: process.env.ALLOW_HTTP_METADATA === "true",
  }),
);
const keeper = config.keeper.enabled
  ? new Keeper(client, config.keeper.keypair!, {
      intervalMs: config.keeper.intervalMs,
      collectFeesMinLamports: config.keeper.collectFeesMinLamports,
      priorityFeeMicroLamports: config.keeper.priorityFeeMicroLamports,
    })
  : null;

if (config.indexer.enabled) {
  indexer.start();
  metadata.start();
}
keeper?.start();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    `[api] listening on http://${info.address}:${info.port} | rpc ${config.rpcUrl} | program ${config.programId.toBase58()}` +
      ` | indexer ${config.indexer.enabled ? "on" : "off"} | keeper ${keeper ? config.keeper.keypair!.publicKey.toBase58() : "off"}`,
  );
});

async function shutdown(signal: string) {
  console.log(`[api] ${signal}, shutting down`);
  keeper?.stop();
  metadata.stop();
  await indexer.stop();
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
