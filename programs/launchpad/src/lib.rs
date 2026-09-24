//! # Launchpad
//!
//! A fair-launch token launchpad for Solana:
//!
//! * anyone launches a token in one transaction (Token-2022, fixed supply,
//!   immutable metadata, no mint or freeze authority);
//! * the token trades on a constant-product bonding curve with virtual
//!   reserves, no initial liquidity required;
//! * when every curve token is sold the curve is complete and anyone can
//!   migrate it: the raised SOL and the reserved tokens seed a Raydium CPMM
//!   pool and the LP tokens are burned, locking the liquidity forever.
//!
//! Fees: a protocol fee and a creator fee (basis points of the SOL amount of
//! each trade), an optional flat creation fee and a flat migration fee. All
//! of them are capped on-chain.

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod raydium;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("AyhSsRnM6gdSSVEQjzTmXBzwnTKVguDZxsxx3E7Q9v2M");

#[program]
pub mod launchpad {
    use super::*;

    // ----------------------------------------------------------------- admin

    /// Creates the global config. Callable once, by the program upgrade authority.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_initialize(ctx, params)
    }

    /// Replaces the admin-settable configuration values.
    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_update_config(ctx, params)
    }

    /// Emergency switches for token creation and trading.
    pub fn set_paused(
        ctx: Context<AdminOnly>,
        create_paused: bool,
        trading_paused: bool,
    ) -> Result<()> {
        instructions::admin::handle_set_paused(ctx, create_paused, trading_paused)
    }

    /// Proposes a new admin (two-step transfer).
    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_transfer_admin(ctx, new_admin)
    }

    /// Accepts a pending admin transfer.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::handle_accept_admin(ctx)
    }

    // ---------------------------------------------------------------- tokens

    /// Launches a new token on a bonding curve.
    pub fn create_token(
        ctx: Context<CreateToken>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::create_token::handle_create_token(ctx, name, symbol, uri)
    }

    /// Buys tokens spending at most `sol_amount` lamports (fees included).
    pub fn buy(ctx: Context<Buy>, sol_amount: u64, min_token_amount: u64) -> Result<()> {
        instructions::trade::handle_buy(ctx, sol_amount, min_token_amount)
    }

    /// Sells exactly `token_amount` tokens for at least `min_sol_amount` lamports.
    pub fn sell(ctx: Context<Sell>, token_amount: u64, min_sol_amount: u64) -> Result<()> {
        instructions::trade::handle_sell(ctx, token_amount, min_sol_amount)
    }

    /// Moves the liquidity of a completed curve to Raydium CPMM (permissionless).
    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        instructions::migrate::handle_migrate(ctx)
    }

    // ------------------------------------------------------------------ fees

    /// Sends the accumulated creator fees to the token creator.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::fees::handle_claim_creator_fees(ctx)
    }

    /// Sends the accumulated protocol fees of a curve to the fee recipient (permissionless).
    pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>) -> Result<()> {
        instructions::fees::handle_collect_protocol_fees(ctx)
    }
}
