use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, Token2022, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    errors::LaunchpadError,
    events::{CurveCompleted, CurveReopened, Trade},
    math::{self, Fees},
    state::{BondingCurve, Config, CurveStatus},
};

#[event_cpi]
#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, mint.key().as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Buys tokens spending at most `sol_amount` lamports (fees included) and
/// receiving at least `min_token_amount` tokens.
///
/// If the curve has fewer tokens left than the budget would buy, the buyer gets
/// all the remaining tokens and pays only what they cost; the curve is then
/// complete and ready to migrate.
pub fn handle_buy(ctx: Context<Buy>, sol_amount: u64, min_token_amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.trading_paused, LaunchpadError::TradingPaused);
    require!(
        ctx.accounts.bonding_curve.is_trading(),
        LaunchpadError::CurveNotTrading
    );

    let fees = Fees {
        protocol_bps: config.protocol_fee_bps,
        creator_bps: config.creator_fee_bps,
    };
    let curve = &ctx.accounts.bonding_curve;
    let quote = math::quote_buy(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        curve.real_token_reserves,
        sol_amount,
        fees,
    )?;
    require!(
        quote.token_amount >= min_token_amount,
        LaunchpadError::SlippageExceeded
    );

    // SOL: reserves and fees are all held by the bonding curve account.
    system_program::transfer(
        CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.bonding_curve.to_account_info(),
            },
        ),
        quote.total_cost,
    )?;

    // Tokens: vault -> buyer, signed by the curve PDA.
    let mint_key = ctx.accounts.mint.key();
    let curve_seeds: &[&[u8]] = &[BONDING_CURVE_SEED, mint_key.as_ref(), &[curve.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.curve_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            &[curve_seeds],
        ),
        quote.token_amount,
        ctx.accounts.mint.decimals,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let curve = &mut ctx.accounts.bonding_curve;
    curve.virtual_sol_reserves = add(curve.virtual_sol_reserves, quote.sol_amount)?;
    curve.virtual_token_reserves = sub(curve.virtual_token_reserves, quote.token_amount)?;
    curve.real_sol_reserves = add(curve.real_sol_reserves, quote.sol_amount)?;
    curve.real_token_reserves = sub(curve.real_token_reserves, quote.token_amount)?;
    curve.protocol_fees = add(curve.protocol_fees, quote.protocol_fee)?;
    curve.creator_fees = add(curve.creator_fees, quote.creator_fee)?;

    emit_cpi!(Trade {
        mint: mint_key,
        trader: ctx.accounts.buyer.key(),
        is_buy: true,
        sol_amount: quote.sol_amount,
        token_amount: quote.token_amount,
        protocol_fee: quote.protocol_fee,
        creator_fee: quote.creator_fee,
        virtual_sol_reserves: curve.virtual_sol_reserves,
        virtual_token_reserves: curve.virtual_token_reserves,
        real_sol_reserves: curve.real_sol_reserves,
        real_token_reserves: curve.real_token_reserves,
        timestamp: now,
    });

    if curve.real_token_reserves == 0 {
        curve.status = CurveStatus::Complete;
        curve.completed_at = now;
        emit_cpi!(CurveCompleted {
            mint: mint_key,
            real_sol_reserves: curve.real_sol_reserves,
            virtual_sol_reserves: curve.virtual_sol_reserves,
            virtual_token_reserves: curve.virtual_token_reserves,
            timestamp: now,
        });
    }
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, mint.key().as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = seller,
        token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
}

/// Sells exactly `token_amount` tokens, receiving at least `min_sol_amount`
/// lamports (fees already deducted).
///
/// A completed curve that could not graduate for [`MIGRATION_TIMEOUT_SECS`]
/// is reopened by the first sell: holders can always get out.
pub fn handle_sell(ctx: Context<Sell>, token_amount: u64, min_sol_amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.config.trading_paused,
        LaunchpadError::TradingPaused
    );
    let now = Clock::get()?.unix_timestamp;
    let reopened = {
        let curve = &mut ctx.accounts.bonding_curve;
        let stuck = curve.status == CurveStatus::Complete
            && now >= curve.completed_at.saturating_add(MIGRATION_TIMEOUT_SECS);
        if stuck {
            curve.status = CurveStatus::Trading;
            curve.completed_at = 0;
        }
        stuck
    };
    require!(
        ctx.accounts.bonding_curve.is_trading(),
        LaunchpadError::CurveNotTrading
    );
    let config = &ctx.accounts.config;

    let fees = Fees {
        protocol_bps: config.protocol_fee_bps,
        creator_bps: config.creator_fee_bps,
    };
    let curve = &ctx.accounts.bonding_curve;
    let quote = math::quote_sell(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        curve.real_sol_reserves,
        token_amount,
        fees,
    )?;
    require!(
        quote.sol_out >= min_sol_amount,
        LaunchpadError::SlippageExceeded
    );

    // Tokens: seller -> vault.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.seller_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.curve_vault.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        quote.token_amount,
        ctx.accounts.mint.decimals,
    )?;

    // SOL: the curve account is owned by this program, so lamports are moved
    // directly. Fees stay in the curve account until claimed.
    ctx.accounts.bonding_curve.sub_lamports(quote.sol_out)?;
    ctx.accounts.seller.add_lamports(quote.sol_out)?;

    let mint_key = ctx.accounts.mint.key();
    if reopened {
        emit_cpi!(CurveReopened {
            mint: mint_key,
            timestamp: now,
        });
    }
    let curve = &mut ctx.accounts.bonding_curve;
    curve.virtual_sol_reserves = sub(curve.virtual_sol_reserves, quote.sol_amount)?;
    curve.virtual_token_reserves = add(curve.virtual_token_reserves, quote.token_amount)?;
    curve.real_sol_reserves = sub(curve.real_sol_reserves, quote.sol_amount)?;
    curve.real_token_reserves = add(curve.real_token_reserves, quote.token_amount)?;
    curve.protocol_fees = add(curve.protocol_fees, quote.protocol_fee)?;
    curve.creator_fees = add(curve.creator_fees, quote.creator_fee)?;

    emit_cpi!(Trade {
        mint: mint_key,
        trader: ctx.accounts.seller.key(),
        is_buy: false,
        sol_amount: quote.sol_amount,
        token_amount: quote.token_amount,
        protocol_fee: quote.protocol_fee,
        creator_fee: quote.creator_fee,
        virtual_sol_reserves: curve.virtual_sol_reserves,
        virtual_token_reserves: curve.virtual_token_reserves,
        real_sol_reserves: curve.real_sol_reserves,
        real_token_reserves: curve.real_token_reserves,
        timestamp: now,
    });
    Ok(())
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}
