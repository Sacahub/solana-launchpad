use anchor_lang::prelude::*;

/// Global configuration PDA: `[CONFIG_SEED]`.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Per-token bonding curve PDA: `[BONDING_CURVE_SEED, mint]`.
/// It is the mint authority during creation, owns the token vault and
/// holds the SOL reserves (as lamports) while the token trades on the curve.
#[constant]
pub const BONDING_CURVE_SEED: &[u8] = b"bonding_curve";

/// Per-token, system-owned PDA used during graduation: `[POOL_CREATOR_SEED, mint]`.
/// It pays for and signs the Raydium CPMM pool creation, receives the LP tokens
/// and burns them. It is fully drained at the end of the migration.
#[constant]
pub const POOL_CREATOR_SEED: &[u8] = b"pool_creator";

/// Per-token PDA used as the Raydium CPMM `pool_state` address: `[RAYDIUM_POOL_SEED, mint]`.
/// Using an address that only this program can sign for (instead of the canonical
/// CPMM PDA) makes the migration impossible to front-run or grief.
#[constant]
pub const RAYDIUM_POOL_SEED: &[u8] = b"raydium_pool";

/// Raydium CPMM program that receives the liquidity at graduation.
///
/// Compiled into the program (not configurable) so that nobody, not even the
/// admin, can redirect the liquidity of a completed curve to another program.
/// Build with `--features devnet` for devnet.
#[cfg(not(feature = "devnet"))]
#[constant]
pub const RAYDIUM_CPMM_PROGRAM_ID: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
#[cfg(feature = "devnet")]
#[constant]
pub const RAYDIUM_CPMM_PROGRAM_ID: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");

/// Decimals of every token launched through the launchpad.
#[constant]
pub const TOKEN_DECIMALS: u8 = 6;

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Hard caps that the admin cannot exceed (protects traders from a malicious or
/// mistaken configuration).
#[constant]
pub const MAX_TOTAL_FEE_BPS: u16 = 500; // 5%
#[constant]
pub const MAX_CREATION_FEE_LAMPORTS: u64 = 1_000_000_000; // 1 SOL
#[constant]
pub const MAX_MIGRATION_FEE_LAMPORTS: u64 = 10_000_000_000_u64; // 10 SOL

/// SOL that a completed curve must leave for the Raydium pool on top of the
/// migration fee (Raydium's own costs are ~0.2 SOL). Enforced when the curve
/// parameters are configured, so that every curve that completes can graduate.
#[constant]
pub const MIN_GRADUATION_LIQUIDITY_LAMPORTS: u64 = 1_000_000_000_u64; // 1 SOL

/// Liveness fallback: a completed curve that could not graduate within this
/// delay (e.g. Raydium disabled pool creation or changed its interface)
/// reopens for selling, so the raised SOL can never be locked forever.
#[constant]
pub const MIGRATION_TIMEOUT_SECS: i64 = 604_800; // 7 days

/// Metadata limits (Token-2022 metadata extension, stored on the mint itself).
#[constant]
pub const MAX_NAME_LEN: u16 = 32;
#[constant]
pub const MAX_SYMBOL_LEN: u16 = 10;
#[constant]
pub const MAX_URI_LEN: u16 = 200;
