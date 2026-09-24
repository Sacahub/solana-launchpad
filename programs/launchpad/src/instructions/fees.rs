use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::LaunchpadError,
    events::{CreatorFeesClaimed, ProtocolFeesCollected},
    state::{BondingCurve, Config},
};

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
        has_one = creator @ LaunchpadError::Unauthorized,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,
}

/// Sends the accumulated creator share of the trading fees to the creator.
/// Works before and after migration.
pub fn handle_claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let amount = ctx.accounts.bonding_curve.creator_fees;
    require!(amount > 0, LaunchpadError::NothingToClaim);

    ctx.accounts.bonding_curve.creator_fees = 0;
    ctx.accounts.bonding_curve.sub_lamports(amount)?;
    ctx.accounts.creator.add_lamports(amount)?;

    emit_cpi!(CreatorFeesClaimed {
        mint: ctx.accounts.bonding_curve.mint,
        creator: ctx.accounts.creator.key(),
        amount,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct CollectProtocolFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    /// CHECK: address checked against the config.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,
}

/// Permissionless crank: moves the protocol share of the trading fees
/// accumulated in a bonding curve to the configured fee recipient.
pub fn handle_collect_protocol_fees(ctx: Context<CollectProtocolFees>) -> Result<()> {
    let amount = ctx.accounts.bonding_curve.protocol_fees;
    require!(amount > 0, LaunchpadError::NothingToClaim);

    ctx.accounts.bonding_curve.protocol_fees = 0;
    ctx.accounts.bonding_curve.sub_lamports(amount)?;
    ctx.accounts.fee_recipient.add_lamports(amount)?;

    emit_cpi!(ProtocolFeesCollected {
        mint: ctx.accounts.bonding_curve.mint,
        fee_recipient: ctx.accounts.fee_recipient.key(),
        amount,
    });
    Ok(())
}
