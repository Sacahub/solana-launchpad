//! Events are emitted through self-CPI (`emit_cpi!`), so they are stored in the
//! transaction's inner instructions and can never be lost to log truncation.

use anchor_lang::prelude::*;

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub create_paused: bool,
    pub trading_paused: bool,
}

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub bonding_curve: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_token_reserves: u64,
    pub token_total_supply: u64,
    pub timestamp: i64,
}

#[event]
pub struct Trade {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    /// Lamports entering (buy) or leaving (sell) the curve, fees excluded.
    pub sol_amount: u64,
    pub token_amount: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    /// Reserves after the trade.
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub timestamp: i64,
}

#[event]
pub struct CurveCompleted {
    pub mint: Pubkey,
    pub real_sol_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub timestamp: i64,
}

#[event]
pub struct Migrated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub lp_mint: Pubkey,
    /// SOL (wrapped) deposited into the pool.
    pub pool_sol_amount: u64,
    /// Tokens deposited into the pool.
    pub pool_token_amount: u64,
    /// Surplus tokens burned to align the pool price with the curve price.
    pub burned_token_amount: u64,
    /// LP tokens burned (liquidity locked forever).
    pub burned_lp_amount: u64,
    /// Protocol revenue collected at migration (migration fee + unclaimed protocol fees + leftovers).
    pub protocol_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CreatorFeesClaimed {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProtocolFeesCollected {
    pub mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub amount: u64,
}
