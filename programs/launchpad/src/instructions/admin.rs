use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::LaunchpadError,
    events::ConfigUpdated,
    program::Launchpad,
    state::{Config, ConfigParams},
};

/// Creates the global config. Only the program's upgrade authority can call it,
/// so nobody can front-run the initialization after deployment.
#[event_cpi]
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        constraint = launchpad_program.programdata_address()? == Some(program_data.key())
            @ LaunchpadError::Unauthorized,
    )]
    pub launchpad_program: Program<'info, Launchpad>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ LaunchpadError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
    params.validate()?;

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = Pubkey::default();
    config.apply(&params);
    config.create_paused = false;
    config.trading_paused = false;
    config.bump = ctx.bumps.config;
    config.reserved = [0; 128];

    emit_cpi!(config_updated_event(config));
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
}

pub fn handle_update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
    params.validate()?;
    let config = &mut ctx.accounts.config;
    config.apply(&params);
    emit_cpi!(config_updated_event(config));
    Ok(())
}

pub fn handle_set_paused(
    ctx: Context<AdminOnly>,
    create_paused: bool,
    trading_paused: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.create_paused = create_paused;
    config.trading_paused = trading_paused;
    emit_cpi!(config_updated_event(config));
    Ok(())
}

/// First step of the admin handover: the new admin must call `accept_admin`.
pub fn handle_transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.pending_admin != Pubkey::default(),
        LaunchpadError::NoPendingAdmin
    );
    require_keys_eq!(
        config.pending_admin,
        ctx.accounts.new_admin.key(),
        LaunchpadError::Unauthorized
    );
    config.admin = config.pending_admin;
    config.pending_admin = Pubkey::default();
    emit_cpi!(config_updated_event(config));
    Ok(())
}

fn config_updated_event(config: &Config) -> ConfigUpdated {
    ConfigUpdated {
        admin: config.admin,
        fee_recipient: config.fee_recipient,
        protocol_fee_bps: config.protocol_fee_bps,
        creator_fee_bps: config.creator_fee_bps,
        create_paused: config.create_paused,
        trading_paused: config.trading_paused,
    }
}
