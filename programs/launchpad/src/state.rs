use anchor_lang::prelude::*;

use crate::{constants::*, errors::LaunchpadError, math};

/// Global launchpad configuration, controlled by the admin.
///
/// Curve parameters only apply to tokens created *after* a change: every
/// bonding curve snapshots its reserves at creation time. Fees are read at
/// trade time and are capped by [`MAX_TOTAL_FEE_BPS`].
#[account]
#[derive(InitSpace, Debug)]
pub struct Config {
    pub admin: Pubkey,
    /// Two-step admin transfer target (`Pubkey::default()` when none).
    pub pending_admin: Pubkey,
    /// Receives protocol trading fees, creation fees and migration fees.
    pub fee_recipient: Pubkey,

    /// Virtual SOL reserves of a new curve (lamports).
    pub initial_virtual_sol_reserves: u64,
    /// Virtual token reserves of a new curve (base units).
    pub initial_virtual_token_reserves: u64,
    /// Tokens sold through the curve; when they run out the curve is complete.
    pub initial_real_token_reserves: u64,
    /// Fixed total supply minted at creation. `token_total_supply -
    /// initial_real_token_reserves` is reserved for the DEX liquidity.
    pub token_total_supply: u64,

    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    /// Flat fee charged to the creator when launching a token.
    pub creation_fee_lamports: u64,
    /// Flat fee taken from the raised SOL when the token graduates.
    pub migration_fee_lamports: u64,

    /// Raydium CPMM pool parameters used at graduation (the program itself
    /// is the compile-time constant [`RAYDIUM_CPMM_PROGRAM_ID`]).
    /// AMM config = fee tier of the pool; must be owned by the Raydium program.
    pub raydium_amm_config: Pubkey,
    /// Raydium's pool creation fee receiver (validated by Raydium itself).
    pub raydium_create_pool_fee: Pubkey,

    pub create_paused: bool,
    pub trading_paused: bool,
    pub bump: u8,
    /// Reserved space: new fields must be carved out of it so that the
    /// account size stays the same and existing accounts keep deserializing.
    pub reserved: [u8; 128],
}

impl Config {
    pub fn apply(&mut self, params: &ConfigParams) {
        self.fee_recipient = params.fee_recipient;
        self.initial_virtual_sol_reserves = params.initial_virtual_sol_reserves;
        self.initial_virtual_token_reserves = params.initial_virtual_token_reserves;
        self.initial_real_token_reserves = params.initial_real_token_reserves;
        self.token_total_supply = params.token_total_supply;
        self.protocol_fee_bps = params.protocol_fee_bps;
        self.creator_fee_bps = params.creator_fee_bps;
        self.creation_fee_lamports = params.creation_fee_lamports;
        self.migration_fee_lamports = params.migration_fee_lamports;
        self.raydium_amm_config = params.raydium_amm_config;
        self.raydium_create_pool_fee = params.raydium_create_pool_fee;
    }
}

/// Admin-settable configuration values (everything except admin and pause flags).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    pub fee_recipient: Pubkey,
    pub initial_virtual_sol_reserves: u64,
    pub initial_virtual_token_reserves: u64,
    pub initial_real_token_reserves: u64,
    pub token_total_supply: u64,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub creation_fee_lamports: u64,
    pub migration_fee_lamports: u64,
    pub raydium_amm_config: Pubkey,
    pub raydium_create_pool_fee: Pubkey,
}

impl ConfigParams {
    pub fn validate(&self) -> Result<()> {
        let total_fee = u32::from(self.protocol_fee_bps) + u32::from(self.creator_fee_bps);
        require!(
            total_fee <= u32::from(MAX_TOTAL_FEE_BPS),
            LaunchpadError::FeeTooHigh
        );
        require!(
            self.fee_recipient != Pubkey::default(),
            LaunchpadError::InvalidConfig
        );
        // Some supply must be left for the DEX pool.
        require!(
            self.initial_virtual_sol_reserves > 0
                && self.initial_real_token_reserves > 0
                && self.initial_virtual_token_reserves > self.initial_real_token_reserves
                && self.token_total_supply > self.initial_real_token_reserves,
            LaunchpadError::InvalidConfig
        );
        require!(
            self.creation_fee_lamports <= MAX_CREATION_FEE_LAMPORTS
                && self.migration_fee_lamports <= MAX_MIGRATION_FEE_LAMPORTS,
            LaunchpadError::InvalidConfig
        );
        // The supply left for the pool must be able to pair all the SOL raised
        // at the final curve price, otherwise the pool would open above it and
        // the first sellers on the DEX would drain it.
        let lp_tokens = self.token_total_supply - self.initial_real_token_reserves;
        require!(
            lp_tokens
                >= math::max_pool_tokens(
                    self.initial_virtual_token_reserves,
                    self.initial_real_token_reserves
                )?,
            LaunchpadError::InvalidConfig
        );
        // A completed curve must raise enough to pay the migration fee and seed
        // the pool, otherwise its liquidity could never graduate.
        let raised = math::sol_to_complete(
            self.initial_virtual_sol_reserves,
            self.initial_virtual_token_reserves,
            self.initial_real_token_reserves,
        )?;
        let needed = self
            .migration_fee_lamports
            .checked_add(MIN_GRADUATION_LIQUIDITY_LAMPORTS)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(raised >= needed, LaunchpadError::InvalidConfig);
        require!(
            self.raydium_amm_config != Pubkey::default()
                && self.raydium_create_pool_fee != Pubkey::default(),
            LaunchpadError::InvalidConfig
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum CurveStatus {
    /// Tokens can be bought and sold on the bonding curve.
    Trading,
    /// All curve tokens were sold: trading is closed, waiting for migration.
    Complete,
    /// Liquidity was moved to Raydium CPMM and the LP tokens were burned.
    Migrated,
}

/// State of a single token launch.
///
/// SOL reserves and unclaimed fees are held as lamports of this very account,
/// so trades only lock per-token accounts and different tokens trade in
/// parallel. Invariant: `lamports >= rent + real_sol_reserves + protocol_fees +
/// creator_fees`.
#[account]
#[derive(InitSpace, Debug)]
pub struct BondingCurve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub token_total_supply: u64,
    /// Unclaimed protocol fees (lamports held by this account).
    pub protocol_fees: u64,
    /// Unclaimed creator fees (lamports held by this account).
    pub creator_fees: u64,
    pub status: CurveStatus,
    pub created_at: i64,
    pub completed_at: i64,
    /// Raydium CPMM pool address once migrated.
    pub raydium_pool: Pubkey,
    /// Migration fee snapshotted at launch: later config changes cannot make
    /// the graduation of an existing token impossible or more expensive.
    pub migration_fee_lamports: u64,
    pub bump: u8,
    /// Reserved space: new fields must be carved out of it so that existing
    /// bonding curves keep deserializing after a program upgrade.
    pub reserved: [u8; 64],
}

impl BondingCurve {
    pub fn is_trading(&self) -> bool {
        self.status == CurveStatus::Trading
    }
}
