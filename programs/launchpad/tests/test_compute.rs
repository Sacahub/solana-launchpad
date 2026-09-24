mod common;

use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Prints the compute units used by each instruction (run with --nocapture)
/// and guards against regressions that would break the SDK's CU limits.
#[test]
fn compute_units_stay_within_sdk_limits() {
    let mut env = Env::initialized();
    let creator = env.new_user(10);
    let mint = Keypair::new();
    let ix = env.create_token_ix(
        &creator.pubkey(),
        &mint.pubkey(),
        "Compute",
        "CU",
        "https://cu",
    );
    let create = env.send(&[ix], &creator, &[&mint]).unwrap();
    let mint = mint.pubkey();

    let trader = env.new_user(100);
    let first_buy = env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0).unwrap();
    let buy = env.buy(&trader, &mint, LAMPORTS_PER_SOL, 0).unwrap();
    let sell = env.sell(&trader, &mint, 1_000_000 * UNIT, 0).unwrap();
    let claim = env.claim_creator_fees(&creator, &mint).unwrap();
    env.complete_curve(&mint);
    let cranker = env.new_user(1);
    let migrate = env.migrate(&cranker, &mint).unwrap();

    let rows = [
        ("create_token", create.compute_units_consumed, 150_000),
        (
            "buy (creates ATA)",
            first_buy.compute_units_consumed,
            120_000,
        ),
        ("buy", buy.compute_units_consumed, 80_000),
        ("sell", sell.compute_units_consumed, 80_000),
        ("claim_creator_fees", claim.compute_units_consumed, 30_000),
        ("migrate", migrate.compute_units_consumed, 400_000),
    ];
    for (name, used, limit) in rows {
        println!("{name:<20} {used:>8} CU (limit {limit})");
        assert!(used <= limit, "{name} uses {used} CU > {limit}");
    }
}
