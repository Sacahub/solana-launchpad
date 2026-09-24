mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{metadata_pointer::MetadataPointer, BaseStateWithExtensions, StateWithExtensions},
};
use common::*;
use launchpad::{
    errors::LaunchpadError,
    events::{CurveCompleted, TokenCreated, Trade},
    math::{self, Fees},
    state::{BondingCurve, CurveStatus},
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const FEES: Fees = Fees {
    protocol_bps: 100,
    creator_bps: 50,
};

fn curve_rent(env: &Env) -> u64 {
    env.rent(8 + <BondingCurve as anchor_lang::Space>::INIT_SPACE)
}

/// The curve account always holds exactly its rent, the SOL reserves and the
/// unclaimed fees.
fn assert_lamports_invariant(env: &Env, mint: &Pubkey) {
    let curve = env.curve(mint);
    assert_eq!(
        env.lamports(&curve_pda(mint)),
        curve_rent(env) + curve.real_sol_reserves + curve.protocol_fees + curve.creator_fees
    );
}

#[test]
fn create_token_launches_a_fixed_supply_token() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let fee_recipient = env.fee_recipient.pubkey();
    let fee_before = env.lamports(&fee_recipient);

    let mint = Keypair::new();
    let ix = env.create_token_ix(
        &creator.pubkey(),
        &mint.pubkey(),
        "Moon Cat",
        "MCAT",
        "https://arweave.net/moon-cat.json",
    );
    let meta = env.send(&[ix], &creator, &[&mint]).unwrap();
    let mint = mint.pubkey();

    // Mint: Token-2022, 6 decimals, whole supply in the vault, no authorities.
    let acc = env.account(&mint).unwrap();
    assert_eq!(acc.owner, anchor_spl::token_2022::ID);
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&acc.data).unwrap();
    assert_eq!(state.base.decimals, 6);
    assert_eq!(state.base.supply, 1_000_000_000 * UNIT);
    assert!(state.base.mint_authority.is_none());
    assert!(state.base.freeze_authority.is_none());
    let pointer = state.get_extension::<MetadataPointer>().unwrap();
    assert_eq!(Option::<Pubkey>::from(pointer.metadata_address), Some(mint));
    assert_eq!(Option::<Pubkey>::from(pointer.authority), None);

    // Metadata stored on the mint and immutable.
    let metadata = token_metadata(&env, &mint);
    assert_eq!(metadata.name, "Moon Cat");
    assert_eq!(metadata.symbol, "MCAT");
    assert_eq!(metadata.uri, "https://arweave.net/moon-cat.json");
    assert_eq!(Option::<Pubkey>::from(metadata.update_authority), None);
    assert_eq!(metadata.mint, mint);

    let curve_key = curve_pda(&mint);
    assert_eq!(
        env.token_balance(&ata_2022(&curve_key, &mint)),
        1_000_000_000 * UNIT
    );

    let curve = env.curve(&mint);
    assert_eq!(curve.mint, mint);
    assert_eq!(curve.creator, creator.pubkey());
    assert_eq!(curve.virtual_sol_reserves, 30 * LAMPORTS_PER_SOL);
    assert_eq!(curve.virtual_token_reserves, 1_073_000_000 * UNIT);
    assert_eq!(curve.real_token_reserves, 793_100_000 * UNIT);
    assert_eq!(curve.real_sol_reserves, 0);
    assert_eq!(curve.status, CurveStatus::Trading);

    // Creation fee charged.
    assert_eq!(env.lamports(&fee_recipient), fee_before + 20_000_000);

    let created = events::<TokenCreated>(&meta);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].mint, mint);
    assert_eq!(created[0].name, "Moon Cat");
    assert_eq!(created[0].creator, creator.pubkey());
    assert_lamports_invariant(&env, &mint);
}

#[test]
fn create_and_dev_buy_in_one_transaction() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = Keypair::new();
    let create = env.create_token_ix(&creator.pubkey(), &mint.pubkey(), "Dev", "DEV", "https://d");
    let buy = env.buy_ix(&creator.pubkey(), &mint.pubkey(), 2 * LAMPORTS_PER_SOL, 0);
    env.send(&[create, buy], &creator, &[&mint]).unwrap();

    let expected = math::quote_buy(
        30 * LAMPORTS_PER_SOL,
        1_073_000_000 * UNIT,
        793_100_000 * UNIT,
        2 * LAMPORTS_PER_SOL,
        FEES,
    )
    .unwrap();
    assert_eq!(
        env.token_balance(&ata_2022(&creator.pubkey(), &mint.pubkey())),
        expected.token_amount
    );
}

#[test]
fn create_token_validates_metadata() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let cases = [
        ("", "SYM", "https://u", LaunchpadError::InvalidName),
        (
            &"n".repeat(33) as &str,
            "SYM",
            "https://u",
            LaunchpadError::InvalidName,
        ),
        ("Name", "", "https://u", LaunchpadError::InvalidSymbol),
        (
            "Name",
            "ELEVENCHARS",
            "https://u",
            LaunchpadError::InvalidSymbol,
        ),
        ("Name", "SYM", "", LaunchpadError::InvalidUri),
        (
            "Name",
            "SYM",
            &"u".repeat(201) as &str,
            LaunchpadError::InvalidUri,
        ),
    ];
    for (name, symbol, uri, err) in cases {
        let mint = Keypair::new();
        let ix = env.create_token_ix(&creator.pubkey(), &mint.pubkey(), name, symbol, uri);
        assert_error(env.send(&[ix], &creator, &[&mint]), err);
    }
    // Limits are inclusive.
    let mint = Keypair::new();
    let ix = env.create_token_ix(
        &creator.pubkey(),
        &mint.pubkey(),
        &"n".repeat(32),
        &"S".repeat(10),
        &"u".repeat(200),
    );
    env.send(&[ix], &creator, &[&mint]).unwrap();
}

#[test]
fn buy_follows_the_curve_and_accrues_fees() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let buyer = env.new_user(10);

    // First buy also creates the buyer's token account (rent paid by the buyer).
    let before = env.lamports(&buyer.pubkey());
    let meta = env.buy(&buyer, &mint, LAMPORTS_PER_SOL, 0).unwrap();
    let q = math::quote_buy(
        30 * LAMPORTS_PER_SOL,
        1_073_000_000 * UNIT,
        793_100_000 * UNIT,
        LAMPORTS_PER_SOL,
        FEES,
    )
    .unwrap();
    let ata = ata_2022(&buyer.pubkey(), &mint);
    let ata_rent = env.lamports(&ata);
    assert_eq!(env.token_balance(&ata), q.token_amount);
    assert_eq!(
        before - env.lamports(&buyer.pubkey()),
        q.total_cost + ata_rent + meta.fee
    );

    let curve = env.curve(&mint);
    assert_eq!(curve.real_sol_reserves, q.sol_amount);
    assert_eq!(
        curve.real_token_reserves,
        793_100_000 * UNIT - q.token_amount
    );
    assert_eq!(
        curve.virtual_sol_reserves,
        30 * LAMPORTS_PER_SOL + q.sol_amount
    );
    assert_eq!(curve.protocol_fees, q.protocol_fee);
    assert_eq!(curve.creator_fees, q.creator_fee);
    assert_lamports_invariant(&env, &mint);

    let trades = events::<Trade>(&meta);
    assert_eq!(trades.len(), 1);
    assert!(trades[0].is_buy);
    assert_eq!(trades[0].token_amount, q.token_amount);
    assert_eq!(trades[0].sol_amount, q.sol_amount);
    assert_eq!(trades[0].real_sol_reserves, curve.real_sol_reserves);

    // Second buy: no ATA rent anymore, exactly the budget is spent.
    let before = env.lamports(&buyer.pubkey());
    let meta = env.buy(&buyer, &mint, LAMPORTS_PER_SOL / 2, 0).unwrap();
    assert_eq!(
        before - env.lamports(&buyer.pubkey()),
        LAMPORTS_PER_SOL / 2 + meta.fee
    );
    assert_lamports_invariant(&env, &mint);
}

#[test]
fn slippage_is_enforced() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let buyer = env.new_user(10);

    let q = math::quote_buy(
        30 * LAMPORTS_PER_SOL,
        1_073_000_000 * UNIT,
        793_100_000 * UNIT,
        LAMPORTS_PER_SOL,
        FEES,
    )
    .unwrap();
    assert_error(
        env.buy(&buyer, &mint, LAMPORTS_PER_SOL, q.token_amount + 1),
        LaunchpadError::SlippageExceeded,
    );
    env.buy(&buyer, &mint, LAMPORTS_PER_SOL, q.token_amount)
        .unwrap();

    let curve = env.curve(&mint);
    let s = math::quote_sell(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        curve.real_sol_reserves,
        q.token_amount,
        FEES,
    )
    .unwrap();
    assert_error(
        env.sell(&buyer, &mint, q.token_amount, s.sol_out + 1),
        LaunchpadError::SlippageExceeded,
    );
    env.sell(&buyer, &mint, q.token_amount, s.sol_out).unwrap();
}

#[test]
fn sell_pays_out_and_round_trip_loses_only_fees() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let trader = env.new_user(10);

    env.buy(&trader, &mint, 3 * LAMPORTS_PER_SOL, 0).unwrap();
    let tokens = env.token_balance(&ata_2022(&trader.pubkey(), &mint));
    let curve = env.curve(&mint);
    let q = math::quote_sell(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        curve.real_sol_reserves,
        tokens,
        FEES,
    )
    .unwrap();

    let before = env.lamports(&trader.pubkey());
    let meta = env.sell(&trader, &mint, tokens, 0).unwrap();
    assert_eq!(
        env.lamports(&trader.pubkey()) + meta.fee - before,
        q.sol_out
    );
    assert_eq!(env.token_balance(&ata_2022(&trader.pubkey(), &mint)), 0);

    let curve = env.curve(&mint);
    // Everything bought was sold back: reserves are back to the start (±rounding in favor of the curve).
    assert_eq!(curve.real_token_reserves, 793_100_000 * UNIT);
    assert!(curve.real_sol_reserves <= 2);
    // Round trip cost ~ 2 x 1.5% fees.
    let lost = 3 * LAMPORTS_PER_SOL - q.sol_out;
    assert!(lost > 88_000_000 && lost < 90_000_000, "lost {lost}");
    assert_lamports_invariant(&env, &mint);

    let trades = events::<Trade>(&meta);
    assert_eq!(trades.len(), 1);
    assert!(!trades[0].is_buy);
}

#[test]
fn cannot_sell_more_than_owned_or_dust() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let trader = env.new_user(10);
    env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0).unwrap();
    let tokens = env.token_balance(&ata_2022(&trader.pubkey(), &mint));

    assert_failed(env.sell(&trader, &mint, tokens + 1, 0));
    assert_error(env.sell(&trader, &mint, 0, 0), LaunchpadError::ZeroAmount);
    assert_error(
        env.sell(&trader, &mint, 1, 0),
        LaunchpadError::AmountTooSmall,
    );
    assert_error(env.buy(&trader, &mint, 0, 0), LaunchpadError::ZeroAmount);
}

#[test]
fn trading_with_a_fake_vault_fails() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let trader = env.new_user(10);
    env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0).unwrap();

    // Point the vault to the trader's own token account.
    let mut ix = env.sell_ix(&trader.pubkey(), &mint, 1_000 * UNIT, 0);
    ix.accounts[4].pubkey = ata_2022(&trader.pubkey(), &mint);
    assert_failed(env.send(&[ix], &trader, &[]));

    // Point the curve to another token's curve.
    let other_mint = env.create_token(&creator);
    let mut ix = env.buy_ix(&trader.pubkey(), &mint, LAMPORTS_PER_SOL, 0);
    ix.accounts[2].pubkey = curve_pda(&other_mint);
    assert_failed(env.send(&[ix], &trader, &[]));
}

#[test]
fn creator_and_protocol_fees_can_be_withdrawn() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let trader = env.new_user(50);
    for _ in 0..5 {
        env.buy(&trader, &mint, 2 * LAMPORTS_PER_SOL, 0).unwrap();
    }
    let tokens = env.token_balance(&ata_2022(&trader.pubkey(), &mint));
    env.sell(&trader, &mint, tokens / 2, 0).unwrap();

    let curve = env.curve(&mint);
    assert!(curve.creator_fees > 0 && curve.protocol_fees > 0);
    // Creator share is 50/150 of the fees.
    let total = curve.creator_fees + curve.protocol_fees;
    assert!(curve.creator_fees.abs_diff(total / 3) <= 6);

    // Only the creator can claim.
    let stranger = env.new_user(1);
    assert_error(
        env.claim_creator_fees(&stranger, &mint),
        LaunchpadError::Unauthorized,
    );

    let before = env.lamports(&creator.pubkey());
    let meta = env.claim_creator_fees(&creator, &mint).unwrap();
    assert_eq!(
        env.lamports(&creator.pubkey()) + meta.fee - before,
        curve.creator_fees
    );
    assert_eq!(env.curve(&mint).creator_fees, 0);
    assert_error(
        env.claim_creator_fees(&creator, &mint),
        LaunchpadError::NothingToClaim,
    );

    // Anyone can push the protocol fees to the fee recipient.
    let fee_recipient = env.fee_recipient.pubkey();
    let before = env.lamports(&fee_recipient);
    env.collect_protocol_fees(&stranger, &mint).unwrap();
    assert_eq!(env.lamports(&fee_recipient) - before, curve.protocol_fees);
    assert_eq!(env.curve(&mint).protocol_fees, 0);
    assert_lamports_invariant(&env, &mint);

    // Trading keeps working and every holder can still exit.
    let rest = env.token_balance(&ata_2022(&trader.pubkey(), &mint));
    env.sell(&trader, &mint, rest, 0).unwrap();
    assert_lamports_invariant(&env, &mint);
}

#[test]
fn last_buy_is_capped_and_completes_the_curve() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let early = env.new_user(100);
    env.buy(&early, &mint, 40 * LAMPORTS_PER_SOL, 0).unwrap();

    let whale = env.new_user(1_000);
    let curve = env.curve(&mint);
    let q = math::quote_buy(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        curve.real_token_reserves,
        500 * LAMPORTS_PER_SOL,
        FEES,
    )
    .unwrap();
    assert!(q.completes_curve);

    let before = env.lamports(&whale.pubkey());
    let meta = env.buy(&whale, &mint, 500 * LAMPORTS_PER_SOL, 0).unwrap();
    let ata = ata_2022(&whale.pubkey(), &mint);
    // Only the cost of the remaining tokens is charged, not the whole budget.
    assert_eq!(
        before - env.lamports(&whale.pubkey()),
        q.total_cost + env.lamports(&ata) + meta.fee
    );
    assert_eq!(env.token_balance(&ata), curve.real_token_reserves);

    let curve = env.curve(&mint);
    assert_eq!(curve.status, CurveStatus::Complete);
    assert_eq!(curve.real_token_reserves, 0);
    assert!(curve.completed_at > 0);
    assert!(curve.real_sol_reserves > 85 * LAMPORTS_PER_SOL);
    assert_eq!(events::<CurveCompleted>(&meta).len(), 1);
    assert_lamports_invariant(&env, &mint);

    // The curve is closed for trading.
    assert_error(
        env.buy(&early, &mint, LAMPORTS_PER_SOL, 0),
        LaunchpadError::CurveNotTrading,
    );
    assert_error(
        env.sell(&early, &mint, 1_000 * UNIT, 0),
        LaunchpadError::CurveNotTrading,
    );
}

#[test]
fn many_traders_random_walk_keeps_accounting_exact() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = env.create_token(&creator);
    let traders: Vec<Keypair> = (0..4).map(|_| env.new_user(100)).collect();

    // Deterministic pseudo-random sequence.
    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..60 {
        let who = &traders[(next() % 4) as usize];
        let ata = ata_2022(&who.pubkey(), &mint);
        let held = env.token_balance(&ata);
        if next() % 3 != 0 || held == 0 {
            let sol = next() % (3 * LAMPORTS_PER_SOL) + 1_000_000;
            env.buy(who, &mint, sol, 0).unwrap();
        } else {
            let tokens = next() % held + 1;
            // Dust sells can legitimately fail with AmountTooSmall.
            let _ = env.sell(who, &mint, tokens, 0);
        }
        assert_lamports_invariant(&env, &mint);
        let curve = env.curve(&mint);
        assert_eq!(
            curve.real_sol_reserves,
            curve.virtual_sol_reserves - 30 * LAMPORTS_PER_SOL
        );
        let vault = env.token_balance(&ata_2022(&curve_pda(&mint), &mint));
        assert_eq!(vault, curve.real_token_reserves + 206_900_000 * UNIT);
    }

    // Everybody sells everything: the curve can pay all of them.
    for who in &traders {
        let held = env.token_balance(&ata_2022(&who.pubkey(), &mint));
        if held > 0 {
            env.sell(who, &mint, held, 0).unwrap();
        }
    }
    let curve = env.curve(&mint);
    assert_eq!(curve.real_token_reserves, 793_100_000 * UNIT);
    assert!(
        curve.real_sol_reserves < 100,
        "dust left: {}",
        curve.real_sol_reserves
    );
    assert_lamports_invariant(&env, &mint);
}
