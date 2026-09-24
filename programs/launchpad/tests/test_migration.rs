mod common;

use anchor_lang::{prelude::Pubkey, solana_program::system_instruction};
use anchor_spl::token::spl_token::native_mint;
use common::*;
use launchpad::{
    errors::LaunchpadError,
    events::Migrated,
    math,
    state::{BondingCurve, CurveStatus},
};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Launches a token whose mint sorts before (`true`) or after (`false`) wSOL,
/// to exercise both Raydium token orderings.
fn create_token_with_order(env: &mut Env, creator: &Keypair, before_wsol: bool) -> Pubkey {
    let mint = loop {
        let k = Keypair::new();
        if (k.pubkey() < native_mint::ID) == before_wsol {
            break k;
        }
    };
    let ix = env.create_token_ix(
        &creator.pubkey(),
        &mint.pubkey(),
        "Graduate",
        "GRAD",
        "https://example.com/grad.json",
    );
    env.send(&[ix], creator, &[&mint]).unwrap();
    mint.pubkey()
}

fn assert_full_migration(before_wsol: bool) {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = create_token_with_order(&mut env, &creator, before_wsol);
    let trader = env.new_user(100);
    env.buy(&trader, &mint, 10 * LAMPORTS_PER_SOL, 0).unwrap();
    env.complete_curve(&mint);

    let curve = env.curve(&mint);
    assert_eq!(curve.status, CurveStatus::Complete);
    let fee_recipient = env.fee_recipient.pubkey();
    let fee_before = env.lamports(&fee_recipient);
    let supply_before = env.mint_supply(&mint);
    let curve_vault = ata_2022(&curve_pda(&mint), &mint);
    let vault_rent = env.lamports(&curve_vault);

    // Anyone can crank the migration and only pays the transaction fee.
    let cranker = env.new_user(1);
    let cranker_before = env.lamports(&cranker.pubkey());
    let meta = env
        .migrate(&cranker, &mint)
        .unwrap_or_else(|e| panic!("migrate failed: {:?}\n{}", e.err, e.meta.pretty_logs()));
    println!("migrate CU: {}", meta.compute_units_consumed);
    assert_eq!(env.lamports(&cranker.pubkey()), cranker_before - meta.fee);

    // ------------------------------------------------------ expected amounts
    let create_pool_fee = 150_000_000;
    let raydium_cost =
        create_pool_fee + env.rent(637) + env.rent(4075) + env.rent(82) + 3 * env.rent(165);
    let pool_sol = curve.real_sol_reserves - 500_000_000 - raydium_cost;
    let pool_tokens = math::pool_token_amount(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        pool_sol,
        206_900_000 * UNIT,
    )
    .unwrap();
    let burned = 206_900_000 * UNIT - pool_tokens;

    let migrated = events::<Migrated>(&meta);
    assert_eq!(migrated.len(), 1);
    let ev = &migrated[0];
    assert_eq!(ev.mint, mint);
    assert_eq!(ev.pool_sol_amount, pool_sol);
    assert_eq!(ev.pool_token_amount, pool_tokens);
    assert_eq!(ev.burned_token_amount, burned);
    assert!(ev.burned_lp_amount > 0);

    // ------------------------------------------------------------- the pool
    let pool = RaydiumPool::for_mint(&mint);
    assert_eq!(pool.mint_is_token_0, before_wsol);
    assert_eq!(ev.pool, pool.pool_state);
    let pool_account = env.account(&pool.pool_state).unwrap();
    assert_eq!(pool_account.owner, RAYDIUM_CPMM);
    assert_eq!(env.token_balance(&pool.wsol_vault()), pool_sol);
    assert_eq!(env.token_balance(&pool.mint_vault()), pool_tokens);
    // Pool price == final curve price (to one base unit).
    assert!(
        u128::from(pool_sol) * u128::from(curve.virtual_token_reserves)
            >= u128::from(curve.virtual_sol_reserves) * u128::from(pool_tokens)
    );
    assert!(
        u128::from(pool_sol) * u128::from(curve.virtual_token_reserves)
            < u128::from(curve.virtual_sol_reserves) * u128::from(pool_tokens + 1)
    );

    // Liquidity locked forever: every LP token minted was burned.
    assert_eq!(env.mint_supply(&pool.lp_mint), 0);

    // Surplus tokens burned, total supply reduced accordingly.
    assert_eq!(env.mint_supply(&mint), supply_before - burned);

    // ---------------------------------------------------------- the curve
    let after = env.curve(&mint);
    assert_eq!(after.status, CurveStatus::Migrated);
    assert_eq!(after.raydium_pool, pool.pool_state);
    assert_eq!(after.real_sol_reserves, 0);
    assert_eq!(after.protocol_fees, 0);
    assert_eq!(after.creator_fees, curve.creator_fees);
    let curve_rent = env.rent(8 + <BondingCurve as anchor_lang::Space>::INIT_SPACE);
    assert_eq!(
        env.lamports(&curve_pda(&mint)),
        curve_rent + after.creator_fees
    );

    // Temporary accounts are gone.
    let pool_creator = pool_creator_pda(&mint);
    assert_eq!(env.lamports(&pool_creator), 0);
    assert!(env.account(&curve_vault).is_none() || env.lamports(&curve_vault) == 0);
    for key in [
        ata_2022(&pool_creator, &mint),
        ata_spl(&pool_creator, &native_mint::ID),
        ata_spl(&pool_creator, &pool.lp_mint),
    ] {
        assert_eq!(env.lamports(&key), 0, "account {key} not closed");
    }

    // Protocol revenue: migration fee + protocol fees + vault rent + LP account rent.
    let protocol = env.lamports(&fee_recipient) - fee_before;
    assert_eq!(protocol, ev.protocol_amount);
    assert_eq!(
        protocol,
        500_000_000 + curve.protocol_fees + vault_rent + env.rent(165)
    );

    // ------------------------------------------------------- after migration
    // The curve cannot be migrated twice (the vault no longer exists) nor traded.
    assert_failed(env.migrate(&cranker, &mint));
    assert_failed(env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0));

    // The creator still gets the fees earned on the curve.
    let creator_before = env.lamports(&creator.pubkey());
    let claim = env.claim_creator_fees(&creator, &mint).unwrap();
    assert_eq!(
        env.lamports(&creator.pubkey()) + claim.fee - creator_before,
        curve.creator_fees
    );

    // The token now trades on Raydium (the pool opens one second after creation).
    env.advance_time(2);
    let dex_trader = env.new_user(10);
    env.raydium_swap(&dex_trader, &mint, true, LAMPORTS_PER_SOL)
        .unwrap_or_else(|e| panic!("raydium buy failed: {:?}\n{}", e.err, e.meta.pretty_logs()));
    let bought = env.token_balance(&ata_2022(&dex_trader.pubkey(), &mint));
    assert!(bought > 0);
    env.raydium_swap(&trader, &mint, false, 1_000_000 * UNIT)
        .unwrap_or_else(|e| panic!("raydium sell failed: {:?}\n{}", e.err, e.meta.pretty_logs()));
}

#[test]
fn migrates_to_raydium_when_mint_sorts_after_wsol() {
    assert_full_migration(false);
}

#[test]
fn migrates_to_raydium_when_mint_sorts_before_wsol() {
    assert_full_migration(true);
}

#[test]
fn cannot_migrate_an_incomplete_curve() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let trader = env.new_user(100);
    env.buy(&trader, &mint, 50 * LAMPORTS_PER_SOL, 0).unwrap();
    assert_error(
        env.migrate(&trader, &mint),
        LaunchpadError::CurveNotComplete,
    );
}

#[test]
fn migration_rejects_a_fake_raydium_program() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    env.complete_curve(&mint);
    let cranker = env.new_user(1);

    // Replace the Raydium program with another executable program.
    let mut ix = env.migrate_ix(&cranker.pubkey(), &mint);
    let idx = ix
        .accounts
        .iter()
        .position(|a| a.pubkey == RAYDIUM_CPMM)
        .unwrap();
    ix.accounts[idx].pubkey = anchor_spl::token::ID;
    assert_error(
        env.send(&[compute_budget_ix(1_000_000), ix], &cranker, &[]),
        LaunchpadError::InvalidRaydiumAccount,
    );

    // Wrong AMM config.
    let mut ix = env.migrate_ix(&cranker.pubkey(), &mint);
    let idx = ix
        .accounts
        .iter()
        .position(|a| a.pubkey == RAYDIUM_AMM_CONFIG)
        .unwrap();
    ix.accounts[idx].pubkey = RAYDIUM_CREATE_POOL_FEE;
    assert_error(
        env.send(&[compute_budget_ix(1_000_000), ix], &cranker, &[]),
        LaunchpadError::InvalidRaydiumAccount,
    );
}

#[test]
fn migration_cannot_be_griefed() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let griefer = env.new_user(10);
    env.buy(&griefer, &mint, LAMPORTS_PER_SOL, 0).unwrap();

    let pool_creator = pool_creator_pda(&mint);
    let pool = RaydiumPool::for_mint(&mint);

    // 1. Pre-create the pool creator's token accounts and send tokens/SOL to them.
    let token_ata = ata_2022(&pool_creator, &mint);
    let wsol_ata = ata_spl(&pool_creator, &native_mint::ID);
    let griefer_ata = ata_2022(&griefer.pubkey(), &mint);
    let ixs = vec![
        create_ata_idempotent_ix(
            &griefer.pubkey(),
            &pool_creator,
            &mint,
            &anchor_spl::token_2022::ID,
        ),
        create_ata_idempotent_ix(
            &griefer.pubkey(),
            &pool_creator,
            &native_mint::ID,
            &anchor_spl::token::ID,
        ),
        anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked(
            &anchor_spl::token_2022::ID,
            &griefer_ata,
            &mint,
            &token_ata,
            &griefer.pubkey(),
            &[],
            1_000 * UNIT,
            6,
        )
        .unwrap(),
        system_instruction::transfer(&griefer.pubkey(), &wsol_ata, 12_345),
        // 2. Pre-fund the pool address and the pool creator PDA.
        system_instruction::transfer(&griefer.pubkey(), &pool.pool_state, 1_000_000),
        system_instruction::transfer(&griefer.pubkey(), &pool_creator, 2_000_000),
        system_instruction::transfer(&griefer.pubkey(), &pool.lp_mint, 3_000_000),
    ];
    env.send(&ixs, &griefer, &[]).unwrap();

    // 3. Create the canonical Raydium pool for the pair first (front-running).
    //    Our pool lives at a different address, so this does not matter.

    env.complete_curve(&mint);
    let cranker = env.new_user(1);
    let meta = env
        .migrate(&cranker, &mint)
        .unwrap_or_else(|e| panic!("migrate failed: {:?}\n{}", e.err, e.meta.pretty_logs()));
    let ev = &events::<Migrated>(&meta)[0];
    // The griefer's tokens were burned with the surplus.
    assert!(ev.burned_token_amount >= 1_000 * UNIT);
    assert_eq!(env.curve(&mint).status, CurveStatus::Migrated);
    assert_eq!(env.lamports(&pool_creator), 0);
    assert_eq!(env.lamports(&token_ata), 0);
    assert_eq!(env.lamports(&wsol_ata), 0);
    assert_eq!(env.mint_supply(&pool.lp_mint), 0);
}

#[test]
fn migration_waits_out_an_unaffordable_raydium_fee() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    env.complete_curve(&mint);
    let cranker = env.new_user(1);

    // Raydium raises its pool creation fee above what the curve raised.
    let original = env.account(&RAYDIUM_AMM_CONFIG).unwrap();
    let mut expensive = original.clone();
    expensive.data[36..44].copy_from_slice(&(100 * LAMPORTS_PER_SOL).to_le_bytes());
    env.svm.set_account(RAYDIUM_AMM_CONFIG, expensive).unwrap();
    assert_error(
        env.migrate(&cranker, &mint),
        LaunchpadError::InsufficientMigrationFunds,
    );
    // Nothing moved: the curve is still complete and funded...
    let curve = env.curve(&mint);
    assert_eq!(curve.status, CurveStatus::Complete);
    assert!(curve.real_sol_reserves > 85 * LAMPORTS_PER_SOL);

    // ...and graduates as soon as the fee is affordable again (or the admin
    // points the config to another Raydium fee tier).
    env.svm.set_account(RAYDIUM_AMM_CONFIG, original).unwrap();
    env.migrate(&cranker, &mint).unwrap();
    assert_eq!(env.curve(&mint).status, CurveStatus::Migrated);
}

#[test]
fn migration_fee_is_fixed_at_launch() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    assert_eq!(env.curve(&mint).migration_fee_lamports, 500_000_000);

    // The admin raises the migration fee after the launch.
    let mut params = default_params(env.fee_recipient.pubkey());
    params.migration_fee_lamports = 5 * LAMPORTS_PER_SOL;
    let ix = env.update_config_ix(&admin.pubkey(), &params);
    env.send(&[ix], &admin, &[]).unwrap();

    env.complete_curve(&mint);
    let cranker = env.new_user(1);
    let meta = env.migrate(&cranker, &mint).unwrap();
    let ev = &events::<Migrated>(&meta)[0];
    let curve_protocol_fees = ev.protocol_amount; // migration fee + protocol fees + rents
    assert!(
        curve_protocol_fees < 2 * LAMPORTS_PER_SOL,
        "old 0.5 SOL fee applies"
    );

    // Tokens launched after the change pay the new fee.
    let later = env.create_token(&creator);
    assert_eq!(
        env.curve(&later).migration_fee_lamports,
        5 * LAMPORTS_PER_SOL
    );
}

#[test]
fn stuck_curve_reopens_for_selling_after_the_timeout() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let holder = env.new_user(100);
    env.buy(&holder, &mint, 20 * LAMPORTS_PER_SOL, 0).unwrap();
    let whale = env.complete_curve(&mint);
    let cranker = env.new_user(1);

    // Raydium disables pool creation for the configured fee tier.
    let original = env.account(&RAYDIUM_AMM_CONFIG).unwrap();
    let mut disabled = original.clone();
    disabled.data[9] = 1;
    env.svm.set_account(RAYDIUM_AMM_CONFIG, disabled).unwrap();
    assert_error(
        env.migrate(&cranker, &mint),
        LaunchpadError::RaydiumPoolCreationDisabled,
    );

    // Before the timeout the curve stays closed...
    let held = env.token_balance(&ata_2022(&holder.pubkey(), &mint));
    env.advance_time(launchpad::constants::MIGRATION_TIMEOUT_SECS - 10);
    assert_error(
        env.sell(&holder, &mint, held, 0),
        LaunchpadError::CurveNotTrading,
    );

    // ...after it, the first sell reopens it and holders can exit.
    env.advance_time(10);
    let meta = env.sell(&holder, &mint, held, 0).unwrap();
    assert_eq!(events::<launchpad::events::CurveReopened>(&meta).len(), 1);
    let curve = env.curve(&mint);
    assert_eq!(curve.status, CurveStatus::Trading);
    assert_eq!(curve.completed_at, 0);
    assert_eq!(curve.real_token_reserves, held);

    // Trading continues normally and the curve can complete again...
    let whale_tokens = env.token_balance(&ata_2022(&whale.pubkey(), &mint));
    env.sell(&whale, &mint, whale_tokens / 2, 0).unwrap();
    env.complete_curve(&mint);
    assert_eq!(env.curve(&mint).status, CurveStatus::Complete);

    // ...and graduate once Raydium accepts pools again.
    env.svm.set_account(RAYDIUM_AMM_CONFIG, original).unwrap();
    env.migrate(&cranker, &mint).unwrap();
    assert_eq!(env.curve(&mint).status, CurveStatus::Migrated);
}
