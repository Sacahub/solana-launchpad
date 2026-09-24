import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { MigratedEvent, TokenCreatedEvent, TradeEvent } from "@launchpad/sdk";

import { MIGRATIONS } from "./schema.js";

/** Where an event comes from. */
export interface EventContext {
  signature: string;
  slot: number;
  blockTime: number;
  eventIndex: number;
}

export type TokenSort = "new" | "market_cap" | "last_trade" | "trending" | "progress";
export type TokenStatusFilter = "trading" | "complete" | "migrated";

export interface TokenRow {
  mint: string;
  bondingCurve: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  description: string | null;
  image: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  status: TokenStatusFilter;
  virtualSolReserves: string;
  virtualTokenReserves: string;
  realSolReserves: string;
  realTokenReserves: string;
  tokenTotalSupply: string;
  priceSol: number;
  marketCapSol: number;
  progress: number;
  volumeSol: string;
  tradeCount: number;
  raydiumPool: string | null;
  createdAt: number;
  lastTradeAt: number | null;
  completedAt: number | null;
  migratedAt: number | null;
  createdSignature: string;
}

export interface TradeRow {
  id: number;
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  trader: string;
  isBuy: boolean;
  solAmount: string;
  tokenAmount: string;
  protocolFee: string;
  creatorFee: string;
  priceSol: number;
  realSolReserves: string;
  realTokenReserves: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** SOL volume (lamports). */
  volume: string;
  trades: number;
}

type Row = Record<string, SQLInputValue>;

const str = (v: SQLInputValue) => (v === null || v === undefined ? null : String(v));
const num = (v: SQLInputValue) => (v === null || v === undefined ? null : Number(v));

/** Spot price in SOL per whole token from reserves (6 decimals, 9 for SOL). */
export const spotPrice = (virtualSol: bigint, virtualToken: bigint): number =>
  (Number(virtualSol) / Number(virtualToken)) * 1e-3;

export class Db {
  readonly sql: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  close(): void {
    this.sql.close();
  }

  private migrate(): void {
    const version = Number((this.sql.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.sql.exec(MIGRATIONS[v]);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.sql.prepare(sql);
      s.setReadBigInts(true);
      this.cache.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    }
  }

  // ------------------------------------------------------------------ meta

  getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.stmt(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  // ---------------------------------------------------------------- writes

  insertToken(ev: TokenCreatedEvent, ctx: EventContext): boolean {
    const price = spotPrice(ev.virtualSolReserves, ev.virtualTokenReserves);
    const res = this.stmt(`
      INSERT OR IGNORE INTO tokens (
        mint, bonding_curve, creator, name, symbol, uri,
        virtual_sol_reserves, virtual_token_reserves, real_sol_reserves, real_token_reserves,
        initial_real_token_reserves, token_total_supply, price_sol, market_cap_sol,
        created_at, created_slot, created_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.mint.toBase58(),
      ev.bondingCurve.toBase58(),
      ev.creator.toBase58(),
      ev.name,
      ev.symbol,
      ev.uri,
      ev.virtualSolReserves,
      ev.virtualTokenReserves,
      ev.realTokenReserves,
      ev.realTokenReserves,
      ev.tokenTotalSupply,
      price,
      price * (Number(ev.tokenTotalSupply) / 1e6),
      ev.timestamp,
      ctx.slot,
      ctx.signature,
    );
    return Number(res.changes) > 0;
  }

  /** Stores a trade and updates the token. Returns false for duplicates. */
  insertTrade(ev: TradeEvent, ctx: EventContext): boolean {
    const mint = ev.mint.toBase58();
    const executionPrice =
      ev.tokenAmount > 0n ? (Number(ev.solAmount) / 1e9) / (Number(ev.tokenAmount) / 1e6) : 0;
    const res = this.stmt(`
      INSERT OR IGNORE INTO trades (
        signature, event_index, slot, block_time, mint, trader, is_buy, sol_amount, token_amount,
        protocol_fee, creator_fee, price_sol, virtual_sol_reserves, virtual_token_reserves,
        real_sol_reserves, real_token_reserves
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ctx.signature,
      ctx.eventIndex,
      ctx.slot,
      ev.timestamp,
      mint,
      ev.trader.toBase58(),
      ev.isBuy ? 1 : 0,
      ev.solAmount,
      ev.tokenAmount,
      ev.protocolFee,
      ev.creatorFee,
      executionPrice,
      ev.virtualSolReserves,
      ev.virtualTokenReserves,
      ev.realSolReserves,
      ev.realTokenReserves,
    );
    if (Number(res.changes) === 0) return false;

    const price = spotPrice(ev.virtualSolReserves, ev.virtualTokenReserves);
    this.stmt(`
      UPDATE tokens SET
        virtual_sol_reserves = ?, virtual_token_reserves = ?,
        real_sol_reserves = ?, real_token_reserves = ?,
        price_sol = ?, market_cap_sol = ? * token_total_supply / 1e6,
        progress = CAST(initial_real_token_reserves - ? AS REAL) * 100.0 / initial_real_token_reserves,
        volume_sol = volume_sol + ?, trade_count = trade_count + 1,
        last_trade_at = MAX(COALESCE(last_trade_at, 0), ?)
      WHERE mint = ?
    `).run(
      ev.virtualSolReserves,
      ev.virtualTokenReserves,
      ev.realSolReserves,
      ev.realTokenReserves,
      price,
      price,
      ev.realTokenReserves,
      ev.solAmount,
      ev.timestamp,
      mint,
    );
    return true;
  }

  markCompleted(mint: string, timestamp: number): void {
    this.stmt(
      "UPDATE tokens SET status = 'complete', completed_at = ?, progress = 100 WHERE mint = ? AND status = 'trading'",
    ).run(timestamp, mint);
  }

  insertGraduation(ev: MigratedEvent, ctx: EventContext): void {
    const mint = ev.mint.toBase58();
    this.stmt(`
      INSERT OR IGNORE INTO graduations (
        mint, pool, lp_mint, pool_sol_amount, pool_token_amount, burned_token_amount,
        burned_lp_amount, protocol_amount, signature, slot, block_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mint,
      ev.pool.toBase58(),
      ev.lpMint.toBase58(),
      ev.poolSolAmount,
      ev.poolTokenAmount,
      ev.burnedTokenAmount,
      ev.burnedLpAmount,
      ev.protocolAmount,
      ctx.signature,
      ctx.slot,
      ev.timestamp,
    );
    this.stmt(`
      UPDATE tokens SET status = 'migrated', raydium_pool = ?, migrated_at = ?,
        completed_at = COALESCE(completed_at, ?), progress = 100, real_sol_reserves = 0,
        token_total_supply = token_total_supply - ?
      WHERE mint = ? AND status != 'migrated'
    `).run(ev.pool.toBase58(), ev.timestamp, ev.timestamp, ev.burnedTokenAmount, mint);
  }

  // ------------------------------------------------------------- metadata

  tokensNeedingMetadata(limit: number, maxAttempts = 5): { mint: string; uri: string }[] {
    const rows = this.stmt(`
      SELECT mint, uri FROM tokens
      WHERE metadata_status = 'pending' AND metadata_attempts < ?
      ORDER BY metadata_attempts, created_at DESC LIMIT ?
    `).all(maxAttempts, limit) as Row[];
    return rows.map((r) => ({ mint: String(r.mint), uri: String(r.uri) }));
  }

  setMetadata(
    mint: string,
    fields: { description?: string; image?: string; twitter?: string; telegram?: string; website?: string },
  ): void {
    this.stmt(`
      UPDATE tokens SET description = ?, image = ?, twitter = ?, telegram = ?, website = ?,
        metadata_status = 'ok', metadata_attempts = metadata_attempts + 1
      WHERE mint = ?
    `).run(
      fields.description ?? null,
      fields.image ?? null,
      fields.twitter ?? null,
      fields.telegram ?? null,
      fields.website ?? null,
      mint,
    );
  }

  metadataFailed(mint: string, maxAttempts = 5): void {
    this.stmt(`
      UPDATE tokens SET metadata_attempts = metadata_attempts + 1,
        metadata_status = CASE WHEN metadata_attempts + 1 >= ? THEN 'error' ELSE 'pending' END
      WHERE mint = ?
    `).run(maxAttempts, mint);
  }

  // ---------------------------------------------------------------- reads

  listTokens(opts: {
    sort?: TokenSort;
    status?: TokenStatusFilter;
    search?: string;
    creator?: string;
    limit?: number;
    offset?: number;
    now?: number;
  }): TokenRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.status) {
      where.push("t.status = ?");
      params.push(opts.status);
    }
    if (opts.creator) {
      where.push("t.creator = ?");
      params.push(opts.creator);
    }
    if (opts.search) {
      where.push("(t.name LIKE ? ESCAPE '\\' OR t.symbol LIKE ? ESCAPE '\\' OR t.mint = ?)");
      const like = `%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, opts.search);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    let join = "";
    let order: string;
    switch (opts.sort ?? "new") {
      case "market_cap":
        order = "t.market_cap_sol DESC";
        break;
      case "last_trade":
        order = "t.last_trade_at DESC NULLS LAST, t.created_at DESC";
        break;
      case "progress":
        order = "t.progress DESC, t.market_cap_sol DESC";
        break;
      case "trending": {
        // SOL volume over the last 6 hours
        const since = (opts.now ?? Math.floor(Date.now() / 1000)) - 6 * 3600;
        join = `LEFT JOIN (
          SELECT mint, SUM(sol_amount) AS recent_volume FROM trades WHERE block_time >= ${since} GROUP BY mint
        ) v ON v.mint = t.mint`;
        order = "COALESCE(v.recent_volume, 0) DESC, t.last_trade_at DESC NULLS LAST";
        break;
      }
      default:
        order = "t.created_at DESC, t.created_slot DESC";
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = this.stmt(
      `SELECT t.* FROM tokens t ${join} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Row[];
    return rows.map(tokenFromRow);
  }

  getToken(mint: string): TokenRow | null {
    const row = this.stmt("SELECT * FROM tokens WHERE mint = ?").get(mint) as Row | undefined;
    return row ? tokenFromRow(row) : null;
  }

  getGraduation(mint: string) {
    const row = this.stmt("SELECT * FROM graduations WHERE mint = ?").get(mint) as Row | undefined;
    if (!row) return null;
    return {
      pool: String(row.pool),
      lpMint: String(row.lp_mint),
      poolSolAmount: String(row.pool_sol_amount),
      poolTokenAmount: String(row.pool_token_amount),
      burnedTokenAmount: String(row.burned_token_amount),
      burnedLpAmount: String(row.burned_lp_amount),
      signature: String(row.signature),
      blockTime: Number(row.block_time),
    };
  }

  listTrades(opts: { mint?: string; trader?: string; limit?: number; beforeId?: number }): TradeRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.mint) {
      where.push("mint = ?");
      params.push(opts.mint);
    }
    if (opts.trader) {
      where.push("trader = ?");
      params.push(opts.trader);
    }
    if (opts.beforeId) {
      where.push("id < ?");
      params.push(opts.beforeId);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.stmt(
      `SELECT * FROM trades ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ).all(...params, limit) as Row[];
    return rows.map(tradeFromRow);
  }

  /** OHLCV candles from the trades (execution prices), oldest first. */
  candles(mint: string, intervalSec: number, from: number, to: number): Candle[] {
    const rows = this.stmt(`
      WITH t AS (
        SELECT id, (block_time / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, price_sol, sol_amount
        FROM trades WHERE mint = ? AND block_time >= ? AND block_time <= ?
      ),
      agg AS (
        SELECT bucket, MIN(id) AS first_id, MAX(id) AS last_id, MAX(price_sol) AS high,
               MIN(price_sol) AS low, SUM(sol_amount) AS volume, COUNT(*) AS trades
        FROM t GROUP BY bucket
      )
      SELECT agg.bucket, o.price_sol AS open, agg.high, agg.low, c.price_sol AS close,
             agg.volume, agg.trades
      FROM agg
      JOIN t o ON o.id = agg.first_id
      JOIN t c ON c.id = agg.last_id
      ORDER BY agg.bucket
    `).all(intervalSec, intervalSec, mint, from, to) as Row[];
    return rows.map((r) => ({
      time: Number(r.bucket),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: String(r.volume),
      trades: Number(r.trades),
    }));
  }

  stats(now = Math.floor(Date.now() / 1000)) {
    const tokens = this.stmt(`
      SELECT COUNT(*) AS total,
             SUM(status = 'trading') AS trading,
             SUM(status = 'complete') AS complete,
             SUM(status = 'migrated') AS migrated
      FROM tokens
    `).get() as Row;
    const volume = this.stmt(`
      SELECT COALESCE(SUM(sol_amount), 0) AS volume, COUNT(*) AS trades
      FROM trades WHERE block_time >= ?
    `).get(now - 24 * 3600) as Row;
    return {
      tokens: Number(tokens.total ?? 0),
      trading: Number(tokens.trading ?? 0),
      complete: Number(tokens.complete ?? 0),
      migrated: Number(tokens.migrated ?? 0),
      volume24hSol: String(volume.volume),
      trades24h: Number(volume.trades),
    };
  }
}

function tokenFromRow(r: Row): TokenRow {
  return {
    mint: String(r.mint),
    bondingCurve: String(r.bonding_curve),
    creator: String(r.creator),
    name: String(r.name),
    symbol: String(r.symbol),
    uri: String(r.uri),
    description: str(r.description),
    image: str(r.image),
    twitter: str(r.twitter),
    telegram: str(r.telegram),
    website: str(r.website),
    status: String(r.status) as TokenStatusFilter,
    virtualSolReserves: String(r.virtual_sol_reserves),
    virtualTokenReserves: String(r.virtual_token_reserves),
    realSolReserves: String(r.real_sol_reserves),
    realTokenReserves: String(r.real_token_reserves),
    tokenTotalSupply: String(r.token_total_supply),
    priceSol: Number(r.price_sol),
    marketCapSol: Number(r.market_cap_sol),
    progress: Number(r.progress),
    volumeSol: String(r.volume_sol),
    tradeCount: Number(r.trade_count),
    raydiumPool: str(r.raydium_pool),
    createdAt: Number(r.created_at),
    lastTradeAt: num(r.last_trade_at),
    completedAt: num(r.completed_at),
    migratedAt: num(r.migrated_at),
    createdSignature: String(r.created_signature),
  };
}

function tradeFromRow(r: Row): TradeRow {
  return {
    id: Number(r.id),
    signature: String(r.signature),
    slot: Number(r.slot),
    blockTime: Number(r.block_time),
    mint: String(r.mint),
    trader: String(r.trader),
    isBuy: Number(r.is_buy) === 1,
    solAmount: String(r.sol_amount),
    tokenAmount: String(r.token_amount),
    protocolFee: String(r.protocol_fee),
    creatorFee: String(r.creator_fee),
    priceSol: Number(r.price_sol),
    realSolReserves: String(r.real_sol_reserves),
    realTokenReserves: String(r.real_token_reserves),
  };
}
