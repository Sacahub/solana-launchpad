use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::{spl_token::native_mint, Token},
    token_interface::{
        self, Burn, CloseAccount, Mint, SyncNative, Token2022, TokenAccount, TransferChecked,
    },
};

use crate::{
    constants::*,
    errors::LaunchpadError,
    events::Migrated,
    math, raydium,
    state::{BondingCurve, Config, CurveStatus},
};

/// Graduates a completed bonding curve to a Raydium CPMM pool.
///
/// Permissionless: anyone (usually a keeper bot) can crank it once the curve
/// is complete. The cranker only fronts the rent of two temporary token
/// accounts, refunded within the same instruction.
///
/// Flow:
/// 1. take the migration fee and the unclaimed protocol fees,
/// 2. fund the `pool_creator` PDA with the pool SOL + Raydium costs,
/// 3. wrap the SOL, move the LP token amount, burn the surplus tokens so the
///    pool opens exactly at the final curve price,
/// 4. create the pool through CPI (the pool address is a PDA of this program,
///    so the migration cannot be front-run),
/// 5. burn all LP tokens: the liquidity is locked forever,
/// 6. close every temporary account and sweep leftovers to the protocol.
#[event_cpi]
#[derive(Accounts)]
pub struct Migrate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, mint.key().as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mut, mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_2022_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: system-owned PDA that creates the pool. Drained at the end.
    #[account(mut, seeds = [POOL_CREATOR_SEED, mint.key().as_ref()], bump)]
    pub pool_creator: UncheckedAccount<'info>,

    /// CHECK: associated token account of `pool_creator` for `mint`, created here.
    #[account(
        mut,
        address = associated_token::get_associated_token_address_with_program_id(
            &pool_creator.key(), &mint.key(), &token_2022_program.key()
        ) @ LaunchpadError::InvalidRaydiumAccount,
    )]
    pub pool_creator_token: UncheckedAccount<'info>,

    /// CHECK: associated wSOL account of `pool_creator`, created here.
    #[account(
        mut,
        address = associated_token::get_associated_token_address_with_program_id(
            &pool_creator.key(), &native_mint::ID, &token_program.key()
        ) @ LaunchpadError::InvalidRaydiumAccount,
    )]
    pub pool_creator_wsol: UncheckedAccount<'info>,

    /// CHECK: LP token account of `pool_creator`, created and validated by Raydium.
    #[account(mut)]
    pub pool_creator_lp: UncheckedAccount<'info>,

    #[account(address = native_mint::ID, mint::token_program = token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: address checked against the config.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,

    /// CHECK: must be the configured Raydium CPMM program.
    #[account(
        executable,
        address = config.raydium_cpmm_program @ LaunchpadError::InvalidRaydiumAccount,
    )]
    pub raydium_program: UncheckedAccount<'info>,

    /// CHECK: must be the configured AMM config; owner checked in the handler.
    #[account(address = config.raydium_amm_config @ LaunchpadError::InvalidRaydiumAccount)]
    pub amm_config: UncheckedAccount<'info>,

    /// CHECK: Raydium vault/LP authority, validated by Raydium.
    pub raydium_authority: UncheckedAccount<'info>,

    /// CHECK: PDA of this program used as the pool address; signs the CPI.
    #[account(mut, seeds = [RAYDIUM_POOL_SEED, mint.key().as_ref()], bump)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: validated by Raydium.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,

    /// CHECK: validated by Raydium (vault of the smaller mint).
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,

    /// CHECK: validated by Raydium (vault of the larger mint).
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium pool creation fee receiver, checked against the config.
    #[account(
        mut,
        address = config.raydium_create_pool_fee @ LaunchpadError::InvalidRaydiumAccount,
    )]
    pub create_pool_fee: UncheckedAccount<'info>,

    /// CHECK: validated by Raydium.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_migrate(ctx: Context<Migrate>) -> Result<()> {
    require!(
        ctx.accounts.bonding_curve.status == CurveStatus::Complete,
        LaunchpadError::CurveNotComplete
    );

    let accounts = &ctx.accounts;
    let mint_key = accounts.mint.key();
    let raydium_program = accounts.raydium_program.key();
    let rent = Rent::get()?;

    // ---------------------------------------------------------------- amounts
    let create_pool_fee =
        raydium::read_amm_config(&accounts.amm_config.to_account_info(), &raydium_program)?;
    let raydium_cost = raydium::pool_creation_cost(&rent, create_pool_fee)?;

    let curve = &accounts.bonding_curve;
    let migration_fee = accounts.config.migration_fee_lamports;
    let pool_sol = curve
        .real_sol_reserves
        .checked_sub(migration_fee)
        .and_then(|v| v.checked_sub(raydium_cost))
        .filter(|v| *v > 0)
        .ok_or(LaunchpadError::InsufficientMigrationFunds)?;

    let vault_tokens = accounts.curve_vault.amount;
    let pool_tokens = math::pool_token_amount(
        curve.virtual_sol_reserves,
        curve.virtual_token_reserves,
        pool_sol,
        vault_tokens,
    )?;
    require!(pool_tokens > 0, LaunchpadError::InsufficientMigrationFunds);
    let burned_tokens = vault_tokens - pool_tokens;
    // Lamports handed to the pool creator: pool liquidity + Raydium costs.
    let to_pool_creator = pool_sol
        .checked_add(raydium_cost)
        .ok_or(LaunchpadError::MathOverflow)?;
    // Lamports sent to the protocol: migration fee + unclaimed protocol fees.
    let to_protocol = migration_fee
        .checked_add(curve.protocol_fees)
        .ok_or(LaunchpadError::MathOverflow)?;

    let curve_bump = [curve.bump];
    let curve_seeds: &[&[u8]] = &[BONDING_CURVE_SEED, mint_key.as_ref(), &curve_bump];
    let creator_bump = [ctx.bumps.pool_creator];
    let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, mint_key.as_ref(), &creator_bump];
    let pool_bump = [ctx.bumps.pool_state];
    let pool_seeds: &[&[u8]] = &[RAYDIUM_POOL_SEED, mint_key.as_ref(), &pool_bump];

    // -------------------------------------------- pool creator token accounts
    // Idempotent: anyone can create an ATA for any owner, so a griefer could
    // create these accounts in advance to block a non-idempotent creation.
    for (ata, token_mint, program) in [
        (
            &accounts.pool_creator_token,
            accounts.mint.to_account_info(),
            accounts.token_2022_program.to_account_info(),
        ),
        (
            &accounts.pool_creator_wsol,
            accounts.wsol_mint.to_account_info(),
            accounts.token_program.to_account_info(),
        ),
    ] {
        associated_token::create_idempotent(CpiContext::new(
            accounts.associated_token_program.key(),
            associated_token::Create {
                payer: accounts.payer.to_account_info(),
                associated_token: ata.to_account_info(),
                authority: accounts.pool_creator.to_account_info(),
                mint: token_mint,
                system_program: accounts.system_program.to_account_info(),
                token_program: program,
            },
        ))?;
    }

    // ------------------------------------------- empty the bonding curve vault
    // The curve account is owned by this program, so its lamports are moved
    // directly. Direct lamport changes are only synchronized with the runtime
    // for the accounts of the next CPI, which must therefore contain both
    // sides of the move: the SOL is parked in the curve vault and the next CPI
    // (vault -> pool creator transfer, signed by the curve) includes both the
    // vault and the curve. Closing the vault then hands everything to the pool
    // creator.
    accounts.bonding_curve.sub_lamports(to_pool_creator)?;
    accounts.curve_vault.add_lamports(to_pool_creator)?;

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_2022_program.key(),
            TransferChecked {
                from: accounts.curve_vault.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.pool_creator_token.to_account_info(),
                authority: accounts.bonding_curve.to_account_info(),
            },
            &[curve_seeds],
        ),
        pool_tokens,
        accounts.mint.decimals,
    )?;
    // Burn the surplus so the pool opens at the final curve price.
    if burned_tokens > 0 {
        token_interface::burn(
            CpiContext::new_with_signer(
                accounts.token_2022_program.key(),
                Burn {
                    mint: accounts.mint.to_account_info(),
                    from: accounts.curve_vault.to_account_info(),
                    authority: accounts.bonding_curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            burned_tokens,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        accounts.token_2022_program.key(),
        CloseAccount {
            account: accounts.curve_vault.to_account_info(),
            destination: accounts.pool_creator.to_account_info(),
            authority: accounts.bonding_curve.to_account_info(),
        },
        &[curve_seeds],
    ))?;

    // ------------------------------------------------------------- wrap SOL
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program::ID,
            system_program::Transfer {
                from: accounts.pool_creator.to_account_info(),
                to: accounts.pool_creator_wsol.to_account_info(),
            },
            &[creator_seeds],
        ),
        pool_sol,
    )?;
    token_interface::sync_native(CpiContext::new(
        accounts.token_program.key(),
        SyncNative {
            account: accounts.pool_creator_wsol.to_account_info(),
        },
    ))?;

    // ------------------------------------------------------- create the pool
    let mint_info = accounts.mint.to_account_info();
    let wsol_info = accounts.wsol_mint.to_account_info();
    let token_info = accounts.pool_creator_token.to_account_info();
    let wsol_account_info = accounts.pool_creator_wsol.to_account_info();
    let t22_info = accounts.token_2022_program.to_account_info();
    let spl_info = accounts.token_program.to_account_info();
    // Raydium requires token_0_mint < token_1_mint.
    let mint_is_token_0 = mint_key < native_mint::ID;
    let (mint_0, mint_1, account_0, account_1, program_0, program_1, amount_0, amount_1) =
        if mint_is_token_0 {
            (
                &mint_info,
                &wsol_info,
                &token_info,
                &wsol_account_info,
                &t22_info,
                &spl_info,
                pool_tokens,
                pool_sol,
            )
        } else {
            (
                &wsol_info,
                &mint_info,
                &wsol_account_info,
                &token_info,
                &spl_info,
                &t22_info,
                pool_sol,
                pool_tokens,
            )
        };

    raydium::initialize(
        &raydium_program,
        raydium::InitializeAccounts {
            creator: &accounts.pool_creator.to_account_info(),
            amm_config: &accounts.amm_config.to_account_info(),
            authority: &accounts.raydium_authority.to_account_info(),
            pool_state: &accounts.pool_state.to_account_info(),
            token_0_mint: mint_0,
            token_1_mint: mint_1,
            lp_mint: &accounts.lp_mint.to_account_info(),
            creator_token_0: account_0,
            creator_token_1: account_1,
            creator_lp_token: &accounts.pool_creator_lp.to_account_info(),
            token_0_vault: &accounts.token_0_vault.to_account_info(),
            token_1_vault: &accounts.token_1_vault.to_account_info(),
            create_pool_fee: &accounts.create_pool_fee.to_account_info(),
            observation_state: &accounts.observation_state.to_account_info(),
            token_program: &spl_info,
            token_0_program: program_0,
            token_1_program: program_1,
            associated_token_program: &accounts.associated_token_program.to_account_info(),
            system_program: &accounts.system_program.to_account_info(),
            rent: &accounts.rent.to_account_info(),
        },
        amount_0,
        amount_1,
        0, // open immediately
        &[creator_seeds, pool_seeds],
    )?;

    // ------------------------------------------------- lock liquidity forever
    let lp_amount = read_token_amount(&accounts.pool_creator_lp.to_account_info())?;
    token_interface::burn(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            Burn {
                mint: accounts.lp_mint.to_account_info(),
                from: accounts.pool_creator_lp.to_account_info(),
                authority: accounts.pool_creator.to_account_info(),
            },
            &[creator_seeds],
        ),
        lp_amount,
    )?;

    // ------------------------------------------------------------- clean up
    // Tokens someone may have sent to the pool creator's account (to make the
    // close below fail) are burned.
    let stray_tokens = read_token_amount(&token_info)?;
    if stray_tokens > 0 {
        token_interface::burn(
            CpiContext::new_with_signer(
                accounts.token_2022_program.key(),
                Burn {
                    mint: accounts.mint.to_account_info(),
                    from: token_info.clone(),
                    authority: accounts.pool_creator.to_account_info(),
                },
                &[creator_seeds],
            ),
            stray_tokens,
        )?;
    }
    // Temporary accounts: rent (and any stray wSOL) back to the cranker who
    // paid for them.
    for (account, program) in [(&token_info, &t22_info), (&wsol_account_info, &spl_info)] {
        token_interface::close_account(CpiContext::new_with_signer(
            program.key(),
            CloseAccount {
                account: account.clone(),
                destination: accounts.payer.to_account_info(),
                authority: accounts.pool_creator.to_account_info(),
            },
            &[creator_seeds],
        ))?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        accounts.token_program.key(),
        CloseAccount {
            account: accounts.pool_creator_lp.to_account_info(),
            destination: accounts.pool_creator.to_account_info(),
            authority: accounts.pool_creator.to_account_info(),
        },
        &[creator_seeds],
    ))?;

    // Whatever the pool creator did not spend (vault rent, LP account rent,
    // donations) goes to the protocol; the PDA ends with zero lamports.
    let leftover = accounts.pool_creator.lamports();
    if leftover > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer {
                    from: accounts.pool_creator.to_account_info(),
                    to: accounts.fee_recipient.to_account_info(),
                },
                &[creator_seeds],
            ),
            leftover,
        )?;
    }

    // Migration fee and protocol fees: direct move, no CPI touches these
    // accounts anymore (the event CPI below only uses the event authority).
    accounts.bonding_curve.sub_lamports(to_protocol)?;
    accounts.fee_recipient.add_lamports(to_protocol)?;

    // --------------------------------------------------------------- state
    let pool_key = accounts.pool_state.key();
    let lp_mint_key = accounts.lp_mint.key();
    let now = Clock::get()?.unix_timestamp;
    let curve = &mut ctx.accounts.bonding_curve;
    curve.status = CurveStatus::Migrated;
    curve.real_sol_reserves = 0;
    curve.real_token_reserves = 0;
    curve.protocol_fees = 0;
    curve.raydium_pool = pool_key;

    emit_cpi!(Migrated {
        mint: mint_key,
        pool: pool_key,
        lp_mint: lp_mint_key,
        pool_sol_amount: pool_sol,
        pool_token_amount: pool_tokens,
        burned_token_amount: burned_tokens + stray_tokens,
        burned_lp_amount: lp_amount,
        protocol_amount: to_protocol + leftover,
        timestamp: now,
    });
    Ok(())
}

/// Reads the `amount` field of an SPL token account (offset 64).
fn read_token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, LaunchpadError::InvalidRaydiumAccount);
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(amount))
}
