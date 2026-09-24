//! Minimal CPI bindings for Raydium CPMM (`raydium-cp-swap`).
//!
//! Only the `initialize` instruction is needed: it creates a constant-product
//! pool, deposits the initial liquidity and mints the LP tokens to the creator.
//! The layout mirrors the official program
//! (<https://github.com/raydium-io/raydium-cp-swap>, `instructions/initialize.rs`).

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};

/// Mainnet program: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`.
/// Devnet program: `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`.
pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const OBSERVATION_SEED: &[u8] = b"observation";

/// `sha256("global:initialize")[..8]`
pub const INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

/// Sizes of the accounts created (and paid for) by the pool creator.
pub const POOL_STATE_LEN: usize = 637;
pub const OBSERVATION_STATE_LEN: usize = 4075;
pub const LP_MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;

/// `AmmConfig` field offsets (8-byte Anchor discriminator included).
pub const AMM_CONFIG_LEN: usize = 236;
pub const AMM_CONFIG_DISABLE_CREATE_POOL_OFFSET: usize = 9;
pub const AMM_CONFIG_CREATE_POOL_FEE_OFFSET: usize = 36;

/// Returns `create_pool_fee` from a Raydium `AmmConfig` account, failing if
/// pool creation is disabled for that config.
pub fn read_amm_config(amm_config: &AccountInfo, raydium_program: &Pubkey) -> Result<u64> {
    require_keys_eq!(
        *amm_config.owner,
        *raydium_program,
        crate::errors::LaunchpadError::InvalidRaydiumAccount
    );
    let data = amm_config.try_borrow_data()?;
    require!(
        data.len() >= AMM_CONFIG_LEN,
        crate::errors::LaunchpadError::InvalidRaydiumAccount
    );
    require!(
        data[AMM_CONFIG_DISABLE_CREATE_POOL_OFFSET] == 0,
        crate::errors::LaunchpadError::RaydiumPoolCreationDisabled
    );
    let mut fee = [0u8; 8];
    fee.copy_from_slice(
        &data[AMM_CONFIG_CREATE_POOL_FEE_OFFSET..AMM_CONFIG_CREATE_POOL_FEE_OFFSET + 8],
    );
    Ok(u64::from_le_bytes(fee))
}

/// Lamports the pool creator spends inside `initialize`: rent of every account
/// Raydium creates plus the pool creation fee.
pub fn pool_creation_cost(rent: &Rent, create_pool_fee: u64) -> Result<u64> {
    [
        rent.minimum_balance(POOL_STATE_LEN),
        rent.minimum_balance(OBSERVATION_STATE_LEN),
        rent.minimum_balance(LP_MINT_LEN),
        // token_0 vault, token_1 vault, creator LP token account
        rent.minimum_balance(TOKEN_ACCOUNT_LEN),
        rent.minimum_balance(TOKEN_ACCOUNT_LEN),
        rent.minimum_balance(TOKEN_ACCOUNT_LEN),
        create_pool_fee,
    ]
    .iter()
    .try_fold(0u64, |acc, x| acc.checked_add(*x))
    .ok_or_else(|| error!(crate::errors::LaunchpadError::MathOverflow))
}

pub struct InitializeAccounts<'a, 'info> {
    pub creator: &'a AccountInfo<'info>,
    pub amm_config: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    pub pool_state: &'a AccountInfo<'info>,
    pub token_0_mint: &'a AccountInfo<'info>,
    pub token_1_mint: &'a AccountInfo<'info>,
    pub lp_mint: &'a AccountInfo<'info>,
    pub creator_token_0: &'a AccountInfo<'info>,
    pub creator_token_1: &'a AccountInfo<'info>,
    pub creator_lp_token: &'a AccountInfo<'info>,
    pub token_0_vault: &'a AccountInfo<'info>,
    pub token_1_vault: &'a AccountInfo<'info>,
    pub create_pool_fee: &'a AccountInfo<'info>,
    pub observation_state: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub token_0_program: &'a AccountInfo<'info>,
    pub token_1_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub rent: &'a AccountInfo<'info>,
}

/// Invokes `raydium_cp_swap::initialize`. Both `creator` and `pool_state` must
/// be PDAs of this program whose seeds are included in `signer_seeds`.
pub fn initialize<'info>(
    raydium_program: &Pubkey,
    accounts: InitializeAccounts<'_, 'info>,
    init_amount_0: u64,
    init_amount_1: u64,
    open_time: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 24);
    data.extend_from_slice(&INITIALIZE_DISCRIMINATOR);
    data.extend_from_slice(&init_amount_0.to_le_bytes());
    data.extend_from_slice(&init_amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());

    let a = &accounts;
    let ix = Instruction {
        program_id: *raydium_program,
        accounts: vec![
            AccountMeta::new(*a.creator.key, true),
            AccountMeta::new_readonly(*a.amm_config.key, false),
            AccountMeta::new_readonly(*a.authority.key, false),
            AccountMeta::new(*a.pool_state.key, true),
            AccountMeta::new_readonly(*a.token_0_mint.key, false),
            AccountMeta::new_readonly(*a.token_1_mint.key, false),
            AccountMeta::new(*a.lp_mint.key, false),
            AccountMeta::new(*a.creator_token_0.key, false),
            AccountMeta::new(*a.creator_token_1.key, false),
            AccountMeta::new(*a.creator_lp_token.key, false),
            AccountMeta::new(*a.token_0_vault.key, false),
            AccountMeta::new(*a.token_1_vault.key, false),
            AccountMeta::new(*a.create_pool_fee.key, false),
            AccountMeta::new(*a.observation_state.key, false),
            AccountMeta::new_readonly(*a.token_program.key, false),
            AccountMeta::new_readonly(*a.token_0_program.key, false),
            AccountMeta::new_readonly(*a.token_1_program.key, false),
            AccountMeta::new_readonly(*a.associated_token_program.key, false),
            AccountMeta::new_readonly(*a.system_program.key, false),
            AccountMeta::new_readonly(*a.rent.key, false),
        ],
        data,
    };

    invoke_signed(
        &ix,
        &[
            a.creator.clone(),
            a.amm_config.clone(),
            a.authority.clone(),
            a.pool_state.clone(),
            a.token_0_mint.clone(),
            a.token_1_mint.clone(),
            a.lp_mint.clone(),
            a.creator_token_0.clone(),
            a.creator_token_1.clone(),
            a.creator_lp_token.clone(),
            a.token_0_vault.clone(),
            a.token_1_vault.clone(),
            a.create_pool_fee.clone(),
            a.observation_state.clone(),
            a.token_program.clone(),
            a.token_0_program.clone(),
            a.token_1_program.clone(),
            a.associated_token_program.clone(),
            a.system_program.clone(),
            a.rent.clone(),
        ],
        signer_seeds,
    )
    .map_err(Into::into)
}
