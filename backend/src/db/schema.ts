/**
 * SQLite schema. Amounts are stored as INTEGER in base units (lamports, token
 * base units): every value produced by the program fits in a signed 64-bit
 * integer. Prices and market caps are REAL (SOL), for display and charts.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tokens (
    mint TEXT PRIMARY KEY,
    bonding_curve TEXT NOT NULL,
    creator TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    uri TEXT NOT NULL,
    description TEXT,
    image TEXT,
    twitter TEXT,
    telegram TEXT,
    website TEXT,
    metadata_status TEXT NOT NULL DEFAULT 'pending',
    metadata_attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'trading',
    virtual_sol_reserves INTEGER NOT NULL,
    virtual_token_reserves INTEGER NOT NULL,
    real_sol_reserves INTEGER NOT NULL DEFAULT 0,
    real_token_reserves INTEGER NOT NULL,
    initial_real_token_reserves INTEGER NOT NULL,
    token_total_supply INTEGER NOT NULL,
    price_sol REAL NOT NULL,
    market_cap_sol REAL NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    volume_sol INTEGER NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    raydium_pool TEXT,
    created_at INTEGER NOT NULL,
    created_slot INTEGER NOT NULL,
    created_signature TEXT NOT NULL,
    last_trade_at INTEGER,
    completed_at INTEGER,
    migrated_at INTEGER
  );
  CREATE INDEX tokens_created_at ON tokens (created_at DESC);
  CREATE INDEX tokens_market_cap ON tokens (market_cap_sol DESC);
  CREATE INDEX tokens_last_trade ON tokens (last_trade_at DESC);
  CREATE INDEX tokens_creator ON tokens (creator);
  CREATE INDEX tokens_status ON tokens (status);
  CREATE INDEX tokens_metadata_status ON tokens (metadata_status);

  -- Rows are inserted in chain order, so id gives a total order of trades.
  CREATE TABLE trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signature TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    block_time INTEGER NOT NULL,
    mint TEXT NOT NULL,
    trader TEXT NOT NULL,
    is_buy INTEGER NOT NULL,
    sol_amount INTEGER NOT NULL,
    token_amount INTEGER NOT NULL,
    protocol_fee INTEGER NOT NULL,
    creator_fee INTEGER NOT NULL,
    price_sol REAL NOT NULL,
    virtual_sol_reserves INTEGER NOT NULL,
    virtual_token_reserves INTEGER NOT NULL,
    real_sol_reserves INTEGER NOT NULL,
    real_token_reserves INTEGER NOT NULL,
    UNIQUE (signature, event_index)
  );
  CREATE INDEX trades_mint_time ON trades (mint, block_time);
  CREATE INDEX trades_mint_id ON trades (mint, id DESC);
  CREATE INDEX trades_trader ON trades (trader, id DESC);
  CREATE INDEX trades_time ON trades (block_time);

  CREATE TABLE graduations (
    mint TEXT PRIMARY KEY,
    pool TEXT NOT NULL,
    lp_mint TEXT NOT NULL,
    pool_sol_amount INTEGER NOT NULL,
    pool_token_amount INTEGER NOT NULL,
    burned_token_amount INTEGER NOT NULL,
    burned_lp_amount INTEGER NOT NULL,
    protocol_amount INTEGER NOT NULL,
    signature TEXT NOT NULL,
    slot INTEGER NOT NULL,
    block_time INTEGER NOT NULL
  );
  `,
];
