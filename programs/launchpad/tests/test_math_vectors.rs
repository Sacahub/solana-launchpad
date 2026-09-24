//! Cross-language golden vectors: the TypeScript SDK must reproduce exactly
//! the quotes computed by the on-chain math. Regenerate with
//! `UPDATE_VECTORS=1 cargo test -p launchpad --test test_math_vectors`.

use launchpad::math::{self, Fees};
use serde_json::{json, Value};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/math_vectors.json"
);

fn generate() -> Value {
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let fees_list = [
        Fees {
            protocol_bps: 100,
            creator_bps: 50,
        },
        Fees {
            protocol_bps: 0,
            creator_bps: 0,
        },
        Fees {
            protocol_bps: 250,
            creator_bps: 250,
        },
        Fees {
            protocol_bps: 37,
            creator_bps: 11,
        },
    ];
    let mut vectors = vec![];
    for i in 0..400 {
        let fees = fees_list[i % fees_list.len()];
        let vt0: u64 = 1_073_000_000_000_000;
        let rt0: u64 = 793_100_000_000_000;
        let vs0: u64 = 30_000_000_000;
        // random position on the curve
        let sold = next() % rt0;
        let vt = vt0 - sold;
        let vs = ((vs0 as u128 * vt0 as u128).div_ceil(vt as u128)) as u64 + next() % 1_000;
        let rt = rt0 - sold;
        let rs = vs - vs0;
        let budget = match i % 4 {
            0 => next() % 1_000,
            1 => next() % 10_000_000_000,
            2 => next() % 200_000_000_000,
            _ => 1 + next() % 100_000,
        };
        let tokens = match i % 3 {
            0 => next() % 1_000_000,
            1 => next() % (sold + 1),
            _ => next() % 100_000_000_000_000,
        };
        let buy = math::quote_buy(vs, vt, rt, budget, fees).ok().map(|q| {
            json!({
                "solAmount": q.sol_amount.to_string(),
                "tokenAmount": q.token_amount.to_string(),
                "protocolFee": q.protocol_fee.to_string(),
                "creatorFee": q.creator_fee.to_string(),
                "totalCost": q.total_cost.to_string(),
                "completesCurve": q.completes_curve,
            })
        });
        let sell = math::quote_sell(vs, vt, rs, tokens, fees).ok().map(|q| {
            json!({
                "solAmount": q.sol_amount.to_string(),
                "protocolFee": q.protocol_fee.to_string(),
                "creatorFee": q.creator_fee.to_string(),
                "solOut": q.sol_out.to_string(),
            })
        });
        vectors.push(json!({
            "curve": {
                "virtualSolReserves": vs.to_string(),
                "virtualTokenReserves": vt.to_string(),
                "realSolReserves": rs.to_string(),
                "realTokenReserves": rt.to_string(),
            },
            "fees": { "protocolFeeBps": fees.protocol_bps, "creatorFeeBps": fees.creator_bps },
            "budget": budget.to_string(),
            "tokens": tokens.to_string(),
            "buy": buy,
            "sell": sell,
        }));
    }
    Value::Array(vectors)
}

#[test]
fn math_vectors_are_up_to_date() {
    let vectors = generate();
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(PATH, serde_json::to_string_pretty(&vectors).unwrap()).unwrap();
        return;
    }
    let stored: Value = serde_json::from_str(
        &std::fs::read_to_string(PATH).expect("run with UPDATE_VECTORS=1 to create the vectors"),
    )
    .unwrap();
    assert_eq!(stored, vectors, "math changed: regenerate the vectors");
}
