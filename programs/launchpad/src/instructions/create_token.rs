use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::spl_token_2022::instruction::AuthorityType,
    token_interface::{
        self, spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize,
        token_metadata_update_authority, Mint, MintTo, SetAuthority, Token2022, TokenAccount,
        TokenMetadataInitialize, TokenMetadataUpdateAuthority,
    },
};

use crate::{
    constants::*,
    errors::LaunchpadError,
    events::TokenCreated,
    state::{BondingCurve, Config, CurveStatus},
};

/// Launches a new token:
/// 1. creates a Token-2022 mint whose metadata (name, symbol, uri) lives on the
///    mint itself and is made immutable,
/// 2. mints the whole fixed supply into the bonding curve vault,
/// 3. revokes the mint authority (no one can ever mint more),
/// 4. opens trading on the bonding curve.
///
/// The mint is a fresh keypair chosen by the client, which allows vanity
/// addresses. The creator can atomically make the first buy by adding a `buy`
/// instruction to the same transaction.
#[event_cpi]
#[derive(Accounts)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = bonding_curve,
        mint::token_program = token_program,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + BondingCurve::INIT_SPACE,
        seeds = [BONDING_CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: only receives the creation fee; address checked against the config.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_token(
    ctx: Context<CreateToken>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.create_paused, LaunchpadError::CreatePaused);
    require!(
        !name.trim().is_empty() && name.len() <= usize::from(MAX_NAME_LEN),
        LaunchpadError::InvalidName
    );
    require!(
        !symbol.trim().is_empty() && symbol.len() <= usize::from(MAX_SYMBOL_LEN),
        LaunchpadError::InvalidSymbol
    );
    require!(
        !uri.trim().is_empty() && uri.len() <= usize::from(MAX_URI_LEN),
        LaunchpadError::InvalidUri
    );

    let mint_key = ctx.accounts.mint.key();
    let curve_key = ctx.accounts.bonding_curve.key();
    let bump = ctx.bumps.bonding_curve;
    let curve_seeds: &[&[u8]] = &[BONDING_CURVE_SEED, mint_key.as_ref(), &[bump]];
    let signer_seeds = &[curve_seeds];
    let token_program_id = ctx.accounts.token_program.key();

    // --- Token metadata (stored in the mint account, Token-2022 extension) ---
    // The mint was created with room for the metadata pointer only; the
    // metadata instruction reallocates it, so top up the rent first.
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(curve_key))?,
        mint: mint_key,
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let mint_info = ctx.accounts.mint.to_account_info();
    let new_size = mint_info
        .data_len()
        .checked_add(metadata.tlv_size_of()?)
        .ok_or(LaunchpadError::MathOverflow)?;
    let required_lamports = Rent::get()?.minimum_balance(new_size);
    let top_up = required_lamports.saturating_sub(mint_info.lamports());
    if top_up > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: mint_info.clone(),
                },
            ),
            top_up,
        )?;
    }

    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program_id,
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: mint_info.clone(),
                update_authority: ctx.accounts.bonding_curve.to_account_info(),
                mint_authority: ctx.accounts.bonding_curve.to_account_info(),
                mint: mint_info.clone(),
            },
            signer_seeds,
        ),
        name.clone(),
        symbol.clone(),
        uri.clone(),
    )?;

    // Metadata is immutable from now on: nobody can rename the token or swap its image.
    token_metadata_update_authority(
        CpiContext::new_with_signer(
            token_program_id,
            TokenMetadataUpdateAuthority {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: mint_info.clone(),
                current_authority: ctx.accounts.bonding_curve.to_account_info(),
                new_authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            signer_seeds,
        ),
        OptionalNonZeroPubkey::default(),
    )?;

    // --- Fixed supply: mint everything to the curve vault, then revoke ---
    token_interface::mint_to(
        CpiContext::new_with_signer(
            token_program_id,
            MintTo {
                mint: mint_info.clone(),
                to: ctx.accounts.curve_vault.to_account_info(),
                authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            signer_seeds,
        ),
        config.token_total_supply,
    )?;

    token_interface::set_authority(
        CpiContext::new_with_signer(
            token_program_id,
            SetAuthority {
                current_authority: ctx.accounts.bonding_curve.to_account_info(),
                account_or_mint: mint_info.clone(),
            },
            signer_seeds,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // --- Creation fee ---
    if config.creation_fee_lamports > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            config.creation_fee_lamports,
        )?;
    }

    // --- Bonding curve state ---
    let now = Clock::get()?.unix_timestamp;
    let curve = &mut ctx.accounts.bonding_curve;
    curve.mint = mint_key;
    curve.creator = ctx.accounts.creator.key();
    curve.virtual_sol_reserves = config.initial_virtual_sol_reserves;
    curve.virtual_token_reserves = config.initial_virtual_token_reserves;
    curve.real_sol_reserves = 0;
    curve.real_token_reserves = config.initial_real_token_reserves;
    curve.token_total_supply = config.token_total_supply;
    curve.protocol_fees = 0;
    curve.creator_fees = 0;
    curve.status = CurveStatus::Trading;
    curve.created_at = now;
    curve.completed_at = 0;
    curve.raydium_pool = Pubkey::default();
    curve.bump = bump;
    curve.reserved = [0; 64];

    emit_cpi!(TokenCreated {
        mint: mint_key,
        bonding_curve: curve_key,
        creator: curve.creator,
        name,
        symbol,
        uri,
        virtual_sol_reserves: curve.virtual_sol_reserves,
        virtual_token_reserves: curve.virtual_token_reserves,
        real_token_reserves: curve.real_token_reserves,
        token_total_supply: curve.token_total_supply,
        timestamp: now,
    });
    Ok(())
}
