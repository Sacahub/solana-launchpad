mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, InstructionData};
use common::*;
use launchpad::{errors::LaunchpadError, state::ConfigParams};
use solana_keypair::Keypair;
use solana_signer::Signer;

fn update_config_ix(env: &Env, admin: &Pubkey, params: &ConfigParams) -> Instruction {
    Instruction::new_with_bytes(
        launchpad::ID,
        &launchpad::instruction::UpdateConfig {
            params: params.clone(),
        }
        .data(),
        env.admin_accounts(admin),
    )
}

fn set_paused_ix(env: &Env, admin: &Pubkey, create: bool, trading: bool) -> Instruction {
    Instruction::new_with_bytes(
        launchpad::ID,
        &launchpad::instruction::SetPaused {
            create_paused: create,
            trading_paused: trading,
        }
        .data(),
        env.admin_accounts(admin),
    )
}

#[test]
fn initialize_sets_the_config() {
    let env = Env::initialized();
    let config = env.config();
    let params = default_params(env.fee_recipient.pubkey());
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.pending_admin, Pubkey::default());
    assert_eq!(config.fee_recipient, params.fee_recipient);
    assert_eq!(config.protocol_fee_bps, 100);
    assert_eq!(config.creator_fee_bps, 50);
    assert_eq!(
        config.initial_virtual_sol_reserves,
        params.initial_virtual_sol_reserves
    );
    assert_eq!(config.raydium_amm_config, RAYDIUM_AMM_CONFIG);
    assert_eq!(launchpad::constants::RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CPMM);
    assert!(!config.create_paused && !config.trading_paused);
}

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut env = Env::new();
    let attacker = env.new_user(10);
    let params = default_params(env.fee_recipient.pubkey());
    let ix = env.initialize_ix(&attacker.pubkey(), &params);
    assert_error(
        env.send(&[ix], &attacker, &[]),
        LaunchpadError::Unauthorized,
    );

    // The real authority succeeds, and only once.
    env.initialize(&params).unwrap();
    assert_failed(env.initialize(&params));
}

#[test]
fn initialize_rejects_invalid_params() {
    let mut env = Env::new();
    let base = default_params(env.fee_recipient.pubkey());

    let mut p = base.clone();
    p.protocol_fee_bps = 400;
    p.creator_fee_bps = 101; // 5.01% > 5% cap
    assert_error(env.initialize(&p), LaunchpadError::FeeTooHigh);

    let mut p = base.clone();
    p.initial_virtual_token_reserves = p.initial_real_token_reserves; // must be strictly greater
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);

    let mut p = base.clone();
    p.token_total_supply = p.initial_real_token_reserves - 1;
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);

    // No supply left for the DEX pool.
    let mut p = base.clone();
    p.token_total_supply = p.initial_real_token_reserves;
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);

    // A curve raising ~0.09 SOL could never pay the migration and seed a pool.
    let mut p = base.clone();
    p.initial_virtual_sol_reserves = LAMPORTS_PER_SOL / 10;
    p.initial_real_token_reserves = 500_000_000 * UNIT;
    p.migration_fee_lamports = 0;
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);

    // Raises ~10.48 SOL: a 10 SOL migration fee would leave less than 1 SOL.
    let mut p = base.clone();
    p.initial_virtual_sol_reserves = 3_700_000_000;
    p.migration_fee_lamports = 10 * LAMPORTS_PER_SOL;
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);
    // Raises ~14.17 SOL: enough.
    p.initial_virtual_sol_reserves = 5 * LAMPORTS_PER_SOL;
    assert!(p.validate().is_ok());

    let mut p = base.clone();
    p.migration_fee_lamports = 10 * LAMPORTS_PER_SOL + 1;
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);

    let mut p = base.clone();
    p.fee_recipient = Pubkey::default();
    assert_error(env.initialize(&p), LaunchpadError::InvalidConfig);

    env.initialize(&base).unwrap();
}

#[test]
fn update_config_is_admin_only_and_validated() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    let mut params = default_params(env.fee_recipient.pubkey());
    params.protocol_fee_bps = 200;
    params.creation_fee_lamports = 0;

    let attacker = env.new_user(1);
    let ix = update_config_ix(&env, &attacker.pubkey(), &params);
    assert_error(
        env.send(&[ix], &attacker, &[]),
        LaunchpadError::Unauthorized,
    );

    let ix = update_config_ix(&env, &admin.pubkey(), &params);
    env.send(&[ix], &admin, &[]).unwrap();
    assert_eq!(env.config().protocol_fee_bps, 200);
    assert_eq!(env.config().creation_fee_lamports, 0);

    params.creator_fee_bps = 400; // 2% + 4% > 5%
    let ix = update_config_ix(&env, &admin.pubkey(), &params);
    assert_error(env.send(&[ix], &admin, &[]), LaunchpadError::FeeTooHigh);
}

#[test]
fn pause_blocks_creation_and_trading() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let trader = env.new_user(10);
    env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0).unwrap();

    let ix = set_paused_ix(&env, &admin.pubkey(), true, true);
    env.send(&[ix], &admin, &[]).unwrap();

    let new_mint = Keypair::new();
    let ix = env.create_token_ix(&creator.pubkey(), &new_mint.pubkey(), "A", "A", "https://a");
    assert_error(
        env.send(&[ix], &creator, &[&new_mint]),
        LaunchpadError::CreatePaused,
    );
    assert_error(
        env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0),
        LaunchpadError::TradingPaused,
    );
    assert_error(
        env.sell(&trader, &mint, 1_000 * UNIT, 0),
        LaunchpadError::TradingPaused,
    );

    let ix = set_paused_ix(&env, &admin.pubkey(), false, false);
    env.send(&[ix], &admin, &[]).unwrap();
    env.sell(&trader, &mint, 1_000 * UNIT, 0).unwrap();
}

#[test]
fn admin_transfer_is_two_step() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    let new_admin = env.new_user(1);
    let stranger = env.new_user(1);

    let ix = Instruction::new_with_bytes(
        launchpad::ID,
        &launchpad::instruction::TransferAdmin {
            new_admin: new_admin.pubkey(),
        }
        .data(),
        env.admin_accounts(&admin.pubkey()),
    );
    env.send(&[ix], &admin, &[]).unwrap();
    assert_eq!(env.config().admin, admin.pubkey());
    assert_eq!(env.config().pending_admin, new_admin.pubkey());

    let accept = |who: &Keypair| {
        Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::AcceptAdmin {}.data(),
            anchor_lang::ToAccountMetas::to_account_metas(
                &launchpad::accounts::AcceptAdmin {
                    new_admin: who.pubkey(),
                    config: config_pda(),
                    event_authority: event_authority(),
                    program: launchpad::ID,
                },
                None,
            ),
        )
    };
    let ix = accept(&stranger);
    assert_error(
        env.send(&[ix], &stranger, &[]),
        LaunchpadError::Unauthorized,
    );

    let ix = accept(&new_admin);
    env.send(&[ix], &new_admin, &[]).unwrap();
    assert_eq!(env.config().admin, new_admin.pubkey());
    assert_eq!(env.config().pending_admin, Pubkey::default());

    // The old admin lost its rights.
    let ix = set_paused_ix(&env, &admin.pubkey(), true, true);
    assert_error(env.send(&[ix], &admin, &[]), LaunchpadError::Unauthorized);
}
