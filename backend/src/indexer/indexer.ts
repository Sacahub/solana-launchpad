/**
 * Chain indexer.
 *
 * A single ingestion loop pulls the program's signatures with
 * `getSignaturesForAddress` (newest first), processes them oldest first and
 * stores a cursor, so rows are always written in chain order and a restart
 * resumes where it stopped. A websocket log subscription only wakes the loop
 * up for low latency; the polling interval covers dropped websocket messages.
 */
import { parseTransactionEvents, type LaunchpadEvent } from "@launchpad/sdk";
import type {
  ConfirmedSignatureInfo,
  Connection,
  PublicKey,
  VersionedTransactionResponse,
} from "@solana/web3.js";

import type { Db, EventContext } from "../db/db.js";
import type { EventBus, LiveEvent } from "./bus.js";

const CURSOR_KEY = "indexer.cursor";
const PAGE = 1000;
const FETCH_CONCURRENCY = 8;

export interface IndexerOptions {
  programId: PublicKey;
  pollIntervalMs: number;
  startSignature?: string;
  log?: (msg: string, extra?: unknown) => void;
}

export class Indexer {
  private stopped = true;
  private subscription: number | null = null;
  private wakeUp: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly opts: IndexerOptions,
  ) {}

  private log(msg: string, extra?: unknown) {
    (this.opts.log ?? ((m, e) => console.log(`[indexer] ${m}`, e ?? "")))(msg, extra);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      this.subscription = this.connection.onLogs(this.opts.programId, () => this.wakeUp?.(), "confirmed");
    } catch (err) {
      this.log("websocket subscription failed, polling only", err);
    }
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeUp?.();
    if (this.subscription !== null) {
      await this.connection.removeOnLogsListener(this.subscription).catch(() => undefined);
      this.subscription = null;
    }
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const n = await this.syncOnce();
        if (n > 0) this.log(`indexed ${n} transactions`);
      } catch (err) {
        this.log("sync failed", err instanceof Error ? err.message : err);
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.pollIntervalMs);
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeUp = null;
    }
  }

  /** Processes every new transaction once. Returns how many were processed. */
  async syncOnce(): Promise<number> {
    const cursor = this.db.getMeta(CURSOR_KEY) ?? this.opts.startSignature ?? undefined;
    const signatures = await this.newSignatures(cursor);
    let processed = 0;
    for (let i = 0; i < signatures.length; i += FETCH_CONCURRENCY) {
      const batch = signatures.slice(i, i + FETCH_CONCURRENCY);
      const txs = await Promise.all(
        batch.map((s) =>
          s.err
            ? Promise.resolve(null)
            : this.connection.getTransaction(s.signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              }),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const info = batch[j];
        const tx = txs[j];
        if (!info.err && !tx) {
          // Not yet available on this RPC node: retry from here next time.
          return processed;
        }
        // Publish only after the commit so clients never see rolled back data.
        const live = this.db.transaction(() => {
          const out = tx && !tx.meta?.err ? this.applyTransaction(tx, info) : [];
          this.db.setMeta(CURSOR_KEY, info.signature);
          return out;
        });
        live.forEach((event) => this.bus.publish(event));
        processed++;
      }
    }
    return processed;
  }

  /** Signatures newer than `until`, oldest first. */
  private async newSignatures(until?: string): Promise<ConfirmedSignatureInfo[]> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(
        this.opts.programId,
        { until, before, limit: PAGE },
        "confirmed",
      );
      all.push(...page);
      if (page.length < PAGE) break;
      before = page[page.length - 1].signature;
    }
    return all.reverse();
  }

  private applyTransaction(tx: VersionedTransactionResponse, info: ConfirmedSignatureInfo): LiveEvent[] {
    const events = parseTransactionEvents(tx, this.opts.programId);
    const blockTime = tx.blockTime ?? info.blockTime ?? Math.floor(Date.now() / 1000);
    const live: LiveEvent[] = [];
    events.forEach((event, eventIndex) => {
      const ctx: EventContext = { signature: info.signature, slot: tx.slot, blockTime, eventIndex };
      const notification = applyEvent(this.db, event, ctx);
      if (notification) live.push(notification);
    });
    return live;
  }
}

/** Writes one event to the database; returns the live notification to publish. */
export function applyEvent(db: Db, event: LaunchpadEvent, ctx: EventContext): LiveEvent | null {
  switch (event.name) {
    case "tokenCreated": {
      if (!db.insertToken(event.data, ctx)) return null;
      const mint = event.data.mint.toBase58();
      return { type: "tokenCreated", mint, signature: ctx.signature, data: db.getToken(mint) };
    }
    case "trade": {
      if (!db.insertTrade(event.data, ctx)) return null;
      const mint = event.data.mint.toBase58();
      const [trade] = db.listTrades({ mint, limit: 1 });
      return { type: "trade", mint, signature: ctx.signature, data: trade };
    }
    case "curveCompleted": {
      const mint = event.data.mint.toBase58();
      db.markCompleted(mint, event.data.timestamp);
      return { type: "curveCompleted", mint, signature: ctx.signature, data: db.getToken(mint) };
    }
    case "curveReopened": {
      const mint = event.data.mint.toBase58();
      db.markReopened(mint);
      return { type: "curveReopened", mint, signature: ctx.signature, data: db.getToken(mint) };
    }
    case "migrated": {
      const mint = event.data.mint.toBase58();
      db.insertGraduation(event.data, ctx);
      return { type: "migrated", mint, signature: ctx.signature, data: db.getGraduation(mint) };
    }
    default:
      return null;
  }
}
