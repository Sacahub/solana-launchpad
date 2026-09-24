//! Bonding curve math and fee logic.
//!
//! The curve is a constant-product market maker over *virtual* reserves:
//! `virtual_sol_reserves * virtual_token_reserves = k`. Virtual reserves give
//! the token a non-zero starting price without anyone depositing liquidity.
//!
//! Every rounding decision favors the curve (and therefore the holders): token
//! amounts paid out are rounded down, SOL amounts paid in are rounded up, fees
//! are rounded up. As a consequence `k` never decreases, which guarantees that
//! the real SOL reserves can always pay back every token that is sold.

use anchor_lang::prelude::*;

use crate::{constants::BPS_DENOMINATOR, errors::LaunchpadError};

const BPS: u128 = BPS_DENOMINATOR as u128;

/// Trading fee configuration, in basis points of the SOL amount.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Fees {
    pub protocol_bps: u16,
    pub creator_bps: u16,
}

impl Fees {
    pub fn total_bps(&self) -> u128 {
        u128::from(self.protocol_bps) + u128::from(self.creator_bps)
    }

    /// Fee due on `amount` lamports, rounded up.
    pub fn fee_on(&self, amount: u64) -> Result<u64> {
        to_u64(ceil_div(u128::from(amount) * self.total_bps(), BPS)?)
    }

    /// Splits a fee between protocol and creator proportionally to their bps.
    /// Rounding dust goes to the protocol. Returns `(protocol, creator)`.
    pub fn split(&self, total_fee: u64) -> (u64, u64) {
        let total_bps = self.total_bps();
        if total_bps == 0 || total_fee == 0 {
            return (total_fee, 0);
        }
        // creator_bps <= total_bps, so the result always fits in u64.
        let creator = (u128::from(total_fee) * u128::from(self.creator_bps) / total_bps) as u64;
        (total_fee - creator, creator)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuyQuote {
    /// Lamports entering the curve reserves (fees excluded).
    pub sol_amount: u64,
    /// Tokens sent to the buyer.
    pub token_amount: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    /// Lamports paid by the buyer: `sol_amount + protocol_fee + creator_fee`.
    /// Never larger than the requested budget.
    pub total_cost: u64,
    /// True when this buy takes the last tokens of the curve.
    pub completes_curve: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SellQuote {
    /// Tokens returned to the curve.
    pub token_amount: u64,
    /// Lamports leaving the curve reserves (fees included).
    pub sol_amount: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    /// Lamports received by the seller: `sol_amount - protocol_fee - creator_fee`.
    pub sol_out: u64,
}

/// Quotes a buy that spends at most `sol_budget` lamports (fees included).
///
/// If the budget buys more tokens than the curve has left, the buy is capped to
/// the remaining tokens and only the SOL needed for them is charged: this is
/// the buy that completes the curve.
pub fn quote_buy(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    real_token_reserves: u64,
    sol_budget: u64,
    fees: Fees,
) -> Result<BuyQuote> {
    require!(sol_budget > 0, LaunchpadError::ZeroAmount);
    require!(real_token_reserves > 0, LaunchpadError::CurveNotTrading);
    require!(
        virtual_sol_reserves > 0 && virtual_token_reserves > real_token_reserves,
        LaunchpadError::InvalidConfig
    );

    let vs = u128::from(virtual_sol_reserves);
    let vt = u128::from(virtual_token_reserves);
    let budget = u128::from(sol_budget);
    let total_bps = fees.total_bps();

    // Largest net amount such that `net + fee(net) <= budget`.
    let mut sol_amount = budget * BPS / (BPS + total_bps);
    let mut fee_total = budget - sol_amount;
    let mut token_amount = vt * sol_amount / (vs + sol_amount);
    let mut completes_curve = false;

    if token_amount >= u128::from(real_token_reserves) {
        token_amount = u128::from(real_token_reserves);
        // Exact SOL needed to take the remaining tokens, rounded up.
        sol_amount = ceil_div(vs * token_amount, vt - token_amount)?;
        fee_total = ceil_div(sol_amount * total_bps, BPS)?;
        completes_curve = true;
    }

    require!(token_amount > 0, LaunchpadError::AmountTooSmall);

    let sol_amount = to_u64(sol_amount)?;
    let fee_total = to_u64(fee_total)?;
    let (protocol_fee, creator_fee) = fees.split(fee_total);
    let total_cost = sol_amount
        .checked_add(fee_total)
        .ok_or(LaunchpadError::MathOverflow)?;
    // Holds by construction; kept as a defensive check.
    require!(total_cost <= sol_budget, LaunchpadError::MathOverflow);

    Ok(BuyQuote {
        sol_amount,
        token_amount: to_u64(token_amount)?,
        protocol_fee,
        creator_fee,
        total_cost,
        completes_curve,
    })
}

/// Quotes selling exactly `token_amount` tokens back to the curve.
pub fn quote_sell(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    real_sol_reserves: u64,
    token_amount: u64,
    fees: Fees,
) -> Result<SellQuote> {
    require!(token_amount > 0, LaunchpadError::ZeroAmount);
    require!(
        virtual_sol_reserves > 0 && virtual_token_reserves > 0,
        LaunchpadError::InvalidConfig
    );

    let vs = u128::from(virtual_sol_reserves);
    let vt = u128::from(virtual_token_reserves);
    let t = u128::from(token_amount);

    let sol_amount = to_u64(vs * t / (vt + t))?;
    require!(
        sol_amount <= real_sol_reserves,
        LaunchpadError::InsufficientReserves
    );

    let fee_total = fees.fee_on(sol_amount)?;
    // total_bps <= 10_000 so the fee can never exceed the amount.
    let sol_out = sol_amount
        .checked_sub(fee_total)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(sol_out > 0, LaunchpadError::AmountTooSmall);
    let (protocol_fee, creator_fee) = fees.split(fee_total);

    Ok(SellQuote {
        token_amount,
        sol_amount,
        protocol_fee,
        creator_fee,
        sol_out,
    })
}

/// SOL entering the reserves (fees excluded) when the remaining
/// `real_token_reserves` are bought, i.e. what a curve raises until completion.
pub fn sol_to_complete(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    real_token_reserves: u64,
) -> Result<u64> {
    require!(
        virtual_token_reserves > real_token_reserves,
        LaunchpadError::InvalidConfig
    );
    to_u64(ceil_div(
        u128::from(virtual_sol_reserves) * u128::from(real_token_reserves),
        u128::from(virtual_token_reserves - real_token_reserves),
    )?)
}

/// Tokens to pair with `sol_amount` in the DEX pool so that the pool opens at
/// (or marginally above) the final price of the curve. Any surplus is burned.
pub fn pool_token_amount(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    sol_amount: u64,
    available_tokens: u64,
) -> Result<u64> {
    require!(virtual_sol_reserves > 0, LaunchpadError::InvalidConfig);
    let tokens = u128::from(sol_amount) * u128::from(virtual_token_reserves)
        / u128::from(virtual_sol_reserves);
    Ok(to_u64(tokens)?.min(available_tokens))
}

fn ceil_div(numerator: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, LaunchpadError::MathOverflow);
    Ok(numerator.div_ceil(denominator))
}

fn to_u64(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| error!(LaunchpadError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const LAMPORTS: u64 = 1_000_000_000;
    const UNIT: u64 = 1_000_000; // 6 decimals
    const VS0: u64 = 30 * LAMPORTS;
    const VT0: u64 = 1_073_000_000 * UNIT;
    const RT0: u64 = 793_100_000 * UNIT;
    const FEES: Fees = Fees {
        protocol_bps: 100,
        creator_bps: 50,
    };

    #[derive(Debug, Clone, Copy)]
    struct Curve {
        vs: u64,
        vt: u64,
        rs: u64,
        rt: u64,
    }

    impl Curve {
        fn new() -> Self {
            Self {
                vs: VS0,
                vt: VT0,
                rs: 0,
                rt: RT0,
            }
        }
        fn k(&self) -> u128 {
            u128::from(self.vs) * u128::from(self.vt)
        }
        fn buy(&mut self, budget: u64) -> Result<BuyQuote> {
            let q = quote_buy(self.vs, self.vt, self.rt, budget, FEES)?;
            self.vs += q.sol_amount;
            self.vt -= q.token_amount;
            self.rs += q.sol_amount;
            self.rt -= q.token_amount;
            Ok(q)
        }
        fn sell(&mut self, tokens: u64) -> Result<SellQuote> {
            let q = quote_sell(self.vs, self.vt, self.rs, tokens, FEES)?;
            self.vs -= q.sol_amount;
            self.vt += q.token_amount;
            self.rs -= q.sol_amount;
            self.rt += q.token_amount;
            Ok(q)
        }
    }

    #[test]
    fn fee_split_is_proportional_and_exact() {
        assert_eq!(FEES.split(150), (100, 50));
        assert_eq!(FEES.split(1), (1, 0));
        assert_eq!(FEES.split(0), (0, 0));
        let no_fees = Fees::default();
        assert_eq!(no_fees.split(10), (10, 0));
        assert_eq!(FEES.fee_on(10_000).unwrap(), 150);
        assert_eq!(FEES.fee_on(1).unwrap(), 1); // rounded up
    }

    #[test]
    fn first_buy_matches_constant_product() {
        let q = quote_buy(VS0, VT0, RT0, LAMPORTS, FEES).unwrap();
        // 1 SOL budget, 1.5% fee on top of the net amount.
        assert_eq!(q.sol_amount, 985_221_674);
        assert_eq!(q.total_cost, LAMPORTS);
        assert_eq!(q.protocol_fee + q.creator_fee, LAMPORTS - q.sol_amount);
        let expected = u128::from(VT0) * u128::from(q.sol_amount)
            / (u128::from(VS0) + u128::from(q.sol_amount));
        assert_eq!(u128::from(q.token_amount), expected);
        assert!(!q.completes_curve);
    }

    #[test]
    fn full_curve_raises_about_85_sol() {
        let mut c = Curve::new();
        let q = c.buy(1_000 * LAMPORTS).unwrap();
        assert!(q.completes_curve);
        assert_eq!(q.token_amount, RT0);
        assert_eq!(c.rt, 0);
        // ~85.005 SOL enter the reserves, paid with a 1.5% fee on top.
        assert!(c.rs > 85 * LAMPORTS && c.rs < 85 * LAMPORTS + LAMPORTS / 100);
        assert!(q.total_cost < 1_000 * LAMPORTS);
        assert_eq!(q.total_cost, q.sol_amount + q.protocol_fee + q.creator_fee);
        // Nothing left to buy.
        assert!(quote_buy(c.vs, c.vt, c.rt, LAMPORTS, FEES).is_err());
    }

    #[test]
    fn sol_to_complete_matches_the_completing_buy() {
        let raised = sol_to_complete(VS0, VT0, RT0).unwrap();
        let mut c = Curve::new();
        c.buy(1_000 * LAMPORTS).unwrap();
        assert_eq!(raised, c.rs);
    }

    #[test]
    fn pool_price_matches_final_curve_price() {
        let mut c = Curve::new();
        c.buy(1_000 * LAMPORTS).unwrap();
        let remaining = 1_000_000_000 * UNIT - RT0; // supply reserved for the LP
        let pool_sol = c.rs - 200_000_000; // minus migration costs
        let pool_tokens = pool_token_amount(c.vs, c.vt, pool_sol, remaining).unwrap();
        assert!(pool_tokens <= remaining);
        // price_pool >= price_curve (cross multiplication)
        assert!(
            u128::from(pool_sol) * u128::from(c.vt) >= u128::from(c.vs) * u128::from(pool_tokens)
        );
        // and within one base unit of it
        assert!(
            u128::from(pool_sol) * u128::from(c.vt)
                < u128::from(c.vs) * u128::from(pool_tokens + 1)
        );
    }

    #[test]
    fn tiny_amounts_are_rejected() {
        assert!(quote_buy(VS0, VT0, RT0, 0, FEES).is_err());
        assert!(quote_sell(VS0, VT0, LAMPORTS, 0, FEES).is_err());
        // One base unit sells for 0 lamports
        assert!(quote_sell(VS0, VT0, LAMPORTS, 1, FEES).is_err());
    }

    #[test]
    fn sell_cannot_exceed_real_reserves() {
        // No SOL in the curve: even a valid sell must fail.
        assert!(quote_sell(VS0, VT0, 0, 1_000 * UNIT, FEES).is_err());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_000))]

        #[test]
        fn buy_never_exceeds_budget_and_k_never_decreases(
            budget in 1u64..=200 * LAMPORTS,
            pre in 0u64..=80 * LAMPORTS,
        ) {
            let mut c = Curve::new();
            if pre > 0 { let _ = c.buy(pre); }
            let k0 = c.k();
            if let Ok(q) = c.buy(budget) {
                prop_assert!(q.total_cost <= budget);
                prop_assert_eq!(q.total_cost, q.sol_amount + q.protocol_fee + q.creator_fee);
                prop_assert!(c.k() >= k0);
                // Fee is at least the nominal fee on the net amount...
                prop_assert!(q.protocol_fee + q.creator_fee >= FEES.fee_on(q.sol_amount).unwrap());
                // ...and at most one lamport more.
                prop_assert!(q.protocol_fee + q.creator_fee <= FEES.fee_on(q.sol_amount).unwrap() + 1);
            }
        }

        #[test]
        fn round_trip_never_profits(
            budget in 1_000u64..=100 * LAMPORTS,
            pre in 0u64..=80 * LAMPORTS,
        ) {
            let mut c = Curve::new();
            if pre > 0 { let _ = c.buy(pre); }
            if let Ok(b) = c.buy(budget) {
                if let Ok(s) = c.sell(b.token_amount) {
                    prop_assert!(s.sol_out <= b.total_cost);
                    prop_assert!(s.sol_amount <= b.sol_amount);
                }
            }
        }

        #[test]
        fn random_trading_keeps_reserves_consistent(
            ops in proptest::collection::vec((any::<bool>(), 1u64..=20 * LAMPORTS), 1..60)
        ) {
            let mut c = Curve::new();
            let mut held: u64 = 0;
            for (is_buy, amount) in ops {
                let k0 = c.k();
                if is_buy {
                    if c.rt == 0 { break; }
                    if let Ok(q) = c.buy(amount) { held += q.token_amount; }
                } else if held > 0 {
                    let tokens = amount % held + 1;
                    if let Ok(q) = c.sell(tokens) { held -= q.token_amount; }
                }
                prop_assert!(c.k() >= k0);
                // Real reserves track virtual reserves exactly.
                prop_assert_eq!(c.rs, c.vs - VS0);
                prop_assert_eq!(c.rt, c.vt - (VT0 - RT0));
                prop_assert_eq!(held, RT0 - c.rt);
            }
            // Everyone can always exit: selling every held token is covered by the reserves.
            if held > 0 {
                let q = quote_sell(c.vs, c.vt, c.rs, held, FEES);
                if let Ok(q) = q { prop_assert!(q.sol_amount <= c.rs); }
                else { prop_assert!(held < 1_000); } // only dust can fail (0 lamports out)
            }
        }
    }
}
