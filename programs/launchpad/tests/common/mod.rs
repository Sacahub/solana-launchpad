//! Shared helpers for the LiteSVM integration tests.
//!
//! The environment loads the freshly built launchpad program together with the
//! real Raydium CPMM program and accounts dumped from mainnet
//! (`tests/fixtures`), so the migration is tested against production code.

#![allow(dead_code, clippy::result_large_err)]

use std::path::PathBuf;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_program,
    },
    AccountDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, ID as ATA_PROGRAM_ID},
    token::{spl_token::native_mint, ID as TOKEN_PROGRAM_ID},
    token_2022::{spl_token_2022, ID as TOKEN_2022_PROGRAM_ID},
};
use base64::Engine;
use launchpad::{
    constants::*,
    raydium,
    state::{BondingCurve, Config, ConfigParams},
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const UNIT: u64 = 1_000_000; // 10^TOKEN_DECIMALS

pub const RAYDIUM_CPMM: Pubkey =
    Pubkey::from_str_const("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const RAYDIUM_AMM_CONFIG: Pubkey =
    Pubkey::from_str_const("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
pub const RAYDIUM_CREATE_POOL_FEE: Pubkey =
    Pubkey::from_str_const("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const BPF_LOADER_UPGRADEABLE: Pubkey =
    Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
const COMPUTE_BUDGET: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");
const RENT_SYSVAR: Pubkey = Pubkey::from_str_const("SysvarRent111111111111111111111111111111111");

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn default_params(fee_recipient: Pubkey) -> ConfigParams {
    ConfigParams {
        fee_recipient,
        initial_virtual_sol_reserves: 30 * LAMPORTS_PER_SOL,
        initial_virtual_token_reserves: 1_073_000_000 * UNIT,
        initial_real_token_reserves: 793_100_000 * UNIT,
        token_total_supply: 1_000_000_000 * UNIT,
        protocol_fee_bps: 100,
        creator_fee_bps: 50,
        creation_fee_lamports: 20_000_000,
        migration_fee_lamports: 500_000_000,
        raydium_amm_config: RAYDIUM_AMM_CONFIG,
        raydium_create_pool_fee: RAYDIUM_CREATE_POOL_FEE,
    }
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn load_json_account(name: &str) -> Account {
    let raw = std::fs::read_to_string(fixtures_dir().join(format!("{name}.json")))
        .unwrap_or_else(|e| panic!("missing fixture {name}.json: {e}"));
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let acc = &v["account"];
    let data = base64::engine::general_purpose::STANDARD
        .decode(acc["data"][0].as_str().unwrap())
        .unwrap();
    Account {
        lamports: acc["lamports"].as_u64().unwrap(),
        data,
        owner: acc["owner"].as_str().unwrap().parse().unwrap(),
        executable: acc["executable"].as_bool().unwrap(),
        rent_epoch: 0,
    }
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &launchpad::ID).0
}
pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn curve_pda(mint: &Pubkey) -> Pubkey {
    pda(&[BONDING_CURVE_SEED, mint.as_ref()])
}
pub fn event_authority() -> Pubkey {
    pda(&[b"__event_authority"])
}
pub fn pool_creator_pda(mint: &Pubkey) -> Pubkey {
    pda(&[POOL_CREATOR_SEED, mint.as_ref()])
}
pub fn raydium_pool_pda(mint: &Pubkey) -> Pubkey {
    pda(&[RAYDIUM_POOL_SEED, mint.as_ref()])
}
pub fn ata_2022(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022_PROGRAM_ID)
}
pub fn ata_spl(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_PROGRAM_ID)
}
pub fn raydium_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &RAYDIUM_CPMM).0
}

pub fn compute_budget_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET, &data, vec![])
}

/// Raydium accounts involved in the migration of `mint`.
pub struct RaydiumPool {
    pub pool_state: Pubkey,
    pub authority: Pubkey,
    pub lp_mint: Pubkey,
    pub token_0_mint: Pubkey,
    pub token_1_mint: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub observation: Pubkey,
    pub mint_is_token_0: bool,
}

impl RaydiumPool {
    pub fn for_mint(mint: &Pubkey) -> Self {
        let pool_state = raydium_pool_pda(mint);
        let mint_is_token_0 = *mint < native_mint::ID;
        let (token_0_mint, token_1_mint) = if mint_is_token_0 {
            (*mint, native_mint::ID)
        } else {
            (native_mint::ID, *mint)
        };
        Self {
            pool_state,
            authority: raydium_pda(&[raydium::AUTH_SEED]),
            lp_mint: raydium_pda(&[raydium::POOL_LP_MINT_SEED, pool_state.as_ref()]),
            token_0_mint,
            token_1_mint,
            token_0_vault: raydium_pda(&[
                raydium::POOL_VAULT_SEED,
                pool_state.as_ref(),
                token_0_mint.as_ref(),
            ]),
            token_1_vault: raydium_pda(&[
                raydium::POOL_VAULT_SEED,
                pool_state.as_ref(),
                token_1_mint.as_ref(),
            ]),
            observation: raydium_pda(&[raydium::OBSERVATION_SEED, pool_state.as_ref()]),
            mint_is_token_0,
        }
    }

    pub fn mint_vault(&self) -> Pubkey {
        if self.mint_is_token_0 {
            self.token_0_vault
        } else {
            self.token_1_vault
        }
    }

    pub fn wsol_vault(&self) -> Pubkey {
        if self.mint_is_token_0 {
            self.token_1_vault
        } else {
            self.token_0_vault
        }
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub fee_recipient: Keypair,
}

impl Env {
    /// Programs and fixtures loaded, config not initialized.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/launchpad.so"
        ));
        svm.add_program(launchpad::ID, program).unwrap();
        svm.add_program(
            RAYDIUM_CPMM,
            &std::fs::read(fixtures_dir().join("raydium_cpmm.so")).unwrap(),
        )
        .unwrap();
        svm.set_account(
            RAYDIUM_AMM_CONFIG,
            load_json_account(&RAYDIUM_AMM_CONFIG.to_string()),
        )
        .unwrap();
        svm.set_account(
            RAYDIUM_CREATE_POOL_FEE,
            load_json_account(&RAYDIUM_CREATE_POOL_FEE.to_string()),
        )
        .unwrap();
        svm.set_account(native_mint::ID, load_json_account("native_mint"))
            .unwrap();

        let admin = Keypair::new();
        let fee_recipient = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100 * LAMPORTS_PER_SOL)
            .unwrap();
        svm.airdrop(&fee_recipient.pubkey(), LAMPORTS_PER_SOL)
            .unwrap();

        let mut env = Self {
            svm,
            admin,
            fee_recipient,
        };
        let admin_key = env.admin.pubkey();
        env.set_upgrade_authority(Some(admin_key));
        // LiteSVM starts at unix time 0: use a realistic date.
        env.advance_time(1_790_000_000);
        env
    }

    /// Programs loaded and config initialized with [`default_params`].
    pub fn initialized() -> Self {
        let mut env = Self::new();
        let params = default_params(env.fee_recipient.pubkey());
        env.initialize(&params).expect("initialize");
        env
    }

    /// LiteSVM deploys programs without upgrade authority: patch the
    /// ProgramData account so `initialize` can check it.
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let program_data =
            Pubkey::find_program_address(&[launchpad::ID.as_ref()], &BPF_LOADER_UPGRADEABLE).0;
        let mut account = self.svm.get_account(&program_data).unwrap();
        // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }
        assert_eq!(&account.data[0..4], &3u32.to_le_bytes());
        match authority {
            Some(key) => {
                account.data[12] = 1;
                account.data[13..45].copy_from_slice(key.as_ref());
            }
            None => {
                account.data[12] = 0;
                account.data[13..45].fill(0);
            }
        }
        self.svm.set_account(program_data, account).unwrap();
    }

    pub fn new_user(&mut self, sol: u64) -> Keypair {
        let user = Keypair::new();
        self.svm
            .airdrop(&user.pubkey(), sol * LAMPORTS_PER_SOL)
            .unwrap();
        user
    }

    pub fn send(&mut self, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> TxResult {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
        let mut all: Vec<&Keypair> = vec![payer];
        all.extend(
            signers
                .iter()
                .copied()
                .filter(|k| k.pubkey() != payer.pubkey()),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    // ------------------------------------------------------------ accounts

    pub fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm.get_account(key)
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn config(&self) -> Config {
        let acc = self.svm.get_account(&config_pda()).unwrap();
        Config::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    pub fn curve(&self, mint: &Pubkey) -> BondingCurve {
        let acc = self.svm.get_account(&curve_pda(mint)).unwrap();
        BondingCurve::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    /// Token amount of an SPL or Token-2022 account (0 if it does not exist).
    pub fn token_balance(&self, key: &Pubkey) -> u64 {
        match self.svm.get_account(key) {
            Some(acc) if acc.data.len() >= 72 => {
                u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
            }
            _ => 0,
        }
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let acc = self.svm.get_account(mint).unwrap();
        u64::from_le_bytes(acc.data[36..44].try_into().unwrap())
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    /// Moves the clock forward (LiteSVM does not advance time by itself).
    pub fn advance_time(&mut self, seconds: i64) {
        let mut clock: anchor_lang::prelude::Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        clock.slot += (seconds as u64) * 3;
        self.svm.set_sysvar(&clock);
    }

    // -------------------------------------------------------- instructions

    pub fn initialize_ix(&self, admin: &Pubkey, params: &ConfigParams) -> Instruction {
        let program_data =
            Pubkey::find_program_address(&[launchpad::ID.as_ref()], &BPF_LOADER_UPGRADEABLE).0;
        Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::Initialize {
                params: params.clone(),
            }
            .data(),
            launchpad::accounts::Initialize {
                admin: *admin,
                config: config_pda(),
                launchpad_program: launchpad::ID,
                program_data,
                system_program: system_program::ID,
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn initialize(&mut self, params: &ConfigParams) -> TxResult {
        let admin = self.admin.insecure_clone();
        let ix = self.initialize_ix(&admin.pubkey(), params);
        self.send(&[ix], &admin, &[])
    }

    pub fn admin_accounts(&self, admin: &Pubkey) -> Vec<AccountMeta> {
        launchpad::accounts::AdminOnly {
            admin: *admin,
            config: config_pda(),
            event_authority: event_authority(),
            program: launchpad::ID,
        }
        .to_account_metas(None)
    }

    pub fn create_token_ix(
        &self,
        creator: &Pubkey,
        mint: &Pubkey,
        name: &str,
        symbol: &str,
        uri: &str,
    ) -> Instruction {
        let curve = curve_pda(mint);
        Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::CreateToken {
                name: name.to_string(),
                symbol: symbol.to_string(),
                uri: uri.to_string(),
            }
            .data(),
            launchpad::accounts::CreateToken {
                creator: *creator,
                config: config_pda(),
                mint: *mint,
                bonding_curve: curve,
                curve_vault: ata_2022(&curve, mint),
                fee_recipient: self.config().fee_recipient,
                token_program: TOKEN_2022_PROGRAM_ID,
                associated_token_program: ATA_PROGRAM_ID,
                system_program: system_program::ID,
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Launches a token with default metadata and returns its mint.
    pub fn create_token(&mut self, creator: &Keypair) -> Pubkey {
        let mint = Keypair::new();
        let ix = self.create_token_ix(
            &creator.pubkey(),
            &mint.pubkey(),
            "Test Coin",
            "TEST",
            "https://example.com/test.json",
        );
        self.send(&[ix], creator, &[&mint]).expect("create_token");
        mint.pubkey()
    }

    pub fn buy_ix(&self, buyer: &Pubkey, mint: &Pubkey, sol: u64, min_tokens: u64) -> Instruction {
        let curve = curve_pda(mint);
        Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::Buy {
                sol_amount: sol,
                min_token_amount: min_tokens,
            }
            .data(),
            launchpad::accounts::Buy {
                buyer: *buyer,
                config: config_pda(),
                bonding_curve: curve,
                mint: *mint,
                curve_vault: ata_2022(&curve, mint),
                buyer_token_account: ata_2022(buyer, mint),
                token_program: TOKEN_2022_PROGRAM_ID,
                associated_token_program: ATA_PROGRAM_ID,
                system_program: system_program::ID,
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn buy(&mut self, buyer: &Keypair, mint: &Pubkey, sol: u64, min_tokens: u64) -> TxResult {
        let ix = self.buy_ix(&buyer.pubkey(), mint, sol, min_tokens);
        self.send(&[ix], buyer, &[])
    }

    pub fn sell_ix(
        &self,
        seller: &Pubkey,
        mint: &Pubkey,
        tokens: u64,
        min_sol: u64,
    ) -> Instruction {
        let curve = curve_pda(mint);
        Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::Sell {
                token_amount: tokens,
                min_sol_amount: min_sol,
            }
            .data(),
            launchpad::accounts::Sell {
                seller: *seller,
                config: config_pda(),
                bonding_curve: curve,
                mint: *mint,
                curve_vault: ata_2022(&curve, mint),
                seller_token_account: ata_2022(seller, mint),
                token_program: TOKEN_2022_PROGRAM_ID,
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn sell(&mut self, seller: &Keypair, mint: &Pubkey, tokens: u64, min_sol: u64) -> TxResult {
        let ix = self.sell_ix(&seller.pubkey(), mint, tokens, min_sol);
        self.send(&[ix], seller, &[])
    }

    pub fn claim_creator_fees(&mut self, creator: &Keypair, mint: &Pubkey) -> TxResult {
        let ix = Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::ClaimCreatorFees {}.data(),
            launchpad::accounts::ClaimCreatorFees {
                creator: creator.pubkey(),
                bonding_curve: curve_pda(mint),
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], creator, &[])
    }

    pub fn collect_protocol_fees(&mut self, payer: &Keypair, mint: &Pubkey) -> TxResult {
        let ix = Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::CollectProtocolFees {}.data(),
            launchpad::accounts::CollectProtocolFees {
                config: config_pda(),
                bonding_curve: curve_pda(mint),
                fee_recipient: self.config().fee_recipient,
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], payer, &[])
    }

    pub fn migrate_ix(&self, payer: &Pubkey, mint: &Pubkey) -> Instruction {
        let curve = curve_pda(mint);
        let pool_creator = pool_creator_pda(mint);
        let pool = RaydiumPool::for_mint(mint);
        Instruction::new_with_bytes(
            launchpad::ID,
            &launchpad::instruction::Migrate {}.data(),
            launchpad::accounts::Migrate {
                payer: *payer,
                config: config_pda(),
                bonding_curve: curve,
                mint: *mint,
                curve_vault: ata_2022(&curve, mint),
                pool_creator,
                pool_creator_token: ata_2022(&pool_creator, mint),
                pool_creator_wsol: ata_spl(&pool_creator, &native_mint::ID),
                pool_creator_lp: ata_spl(&pool_creator, &pool.lp_mint),
                wsol_mint: native_mint::ID,
                fee_recipient: self.config().fee_recipient,
                raydium_program: RAYDIUM_CPMM,
                amm_config: RAYDIUM_AMM_CONFIG,
                raydium_authority: pool.authority,
                pool_state: pool.pool_state,
                lp_mint: pool.lp_mint,
                token_0_vault: pool.token_0_vault,
                token_1_vault: pool.token_1_vault,
                create_pool_fee: RAYDIUM_CREATE_POOL_FEE,
                observation_state: pool.observation,
                token_program: TOKEN_PROGRAM_ID,
                token_2022_program: TOKEN_2022_PROGRAM_ID,
                associated_token_program: ATA_PROGRAM_ID,
                system_program: system_program::ID,
                rent: RENT_SYSVAR,
                event_authority: event_authority(),
                program: launchpad::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn migrate(&mut self, payer: &Keypair, mint: &Pubkey) -> TxResult {
        let ixs = [
            compute_budget_ix(1_000_000),
            self.migrate_ix(&payer.pubkey(), mint),
        ];
        self.send(&ixs, payer, &[])
    }

    /// Buys until the curve is complete. Returns the buyer.
    pub fn complete_curve(&mut self, mint: &Pubkey) -> Keypair {
        let whale = self.new_user(1_000);
        self.buy(&whale, mint, 200 * LAMPORTS_PER_SOL, 0)
            .expect("completing buy");
        whale
    }

    /// Swaps `amount_in` of `input_mint` on the Raydium pool (swap_base_input).
    pub fn raydium_swap(
        &mut self,
        user: &Keypair,
        mint: &Pubkey,
        buy_token: bool,
        amount_in: u64,
    ) -> TxResult {
        let pool = RaydiumPool::for_mint(mint);
        let user_token = ata_2022(&user.pubkey(), mint);
        let user_wsol = ata_spl(&user.pubkey(), &native_mint::ID);
        let (input_account, output_account, input_vault, output_vault) = if buy_token {
            (user_wsol, user_token, pool.wsol_vault(), pool.mint_vault())
        } else {
            (user_token, user_wsol, pool.mint_vault(), pool.wsol_vault())
        };
        let (input_program, output_program, input_mint, output_mint) = if buy_token {
            (
                TOKEN_PROGRAM_ID,
                TOKEN_2022_PROGRAM_ID,
                native_mint::ID,
                *mint,
            )
        } else {
            (
                TOKEN_2022_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                *mint,
                native_mint::ID,
            )
        };
        let mut ixs = vec![
            create_ata_idempotent_ix(
                &user.pubkey(),
                &user.pubkey(),
                &native_mint::ID,
                &TOKEN_PROGRAM_ID,
            ),
            create_ata_idempotent_ix(&user.pubkey(), &user.pubkey(), mint, &TOKEN_2022_PROGRAM_ID),
        ];
        if buy_token {
            ixs.push(anchor_lang::solana_program::system_instruction::transfer(
                &user.pubkey(),
                &user_wsol,
                amount_in,
            ));
            ixs.push(
                anchor_spl::token::spl_token::instruction::sync_native(
                    &TOKEN_PROGRAM_ID,
                    &user_wsol,
                )
                .unwrap(),
            );
        }
        // swap_base_input(amount_in, minimum_amount_out)
        let mut data = vec![143, 190, 90, 218, 196, 30, 51, 222];
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        ixs.push(Instruction::new_with_bytes(
            RAYDIUM_CPMM,
            &data,
            vec![
                AccountMeta::new_readonly(user.pubkey(), true),
                AccountMeta::new_readonly(pool.authority, false),
                AccountMeta::new_readonly(RAYDIUM_AMM_CONFIG, false),
                AccountMeta::new(pool.pool_state, false),
                AccountMeta::new(input_account, false),
                AccountMeta::new(output_account, false),
                AccountMeta::new(input_vault, false),
                AccountMeta::new(output_vault, false),
                AccountMeta::new_readonly(input_program, false),
                AccountMeta::new_readonly(output_program, false),
                AccountMeta::new_readonly(input_mint, false),
                AccountMeta::new_readonly(output_mint, false),
                AccountMeta::new(pool.observation, false),
            ],
        ));
        self.send(&ixs, user, &[])
    }
}

pub fn create_ata_idempotent_ix(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        ATA_PROGRAM_ID,
        &[1],
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(
                get_associated_token_address_with_program_id(owner, mint, token_program),
                false,
            ),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
    )
}

/// Asserts that a transaction failed with the given launchpad error.
pub fn assert_error(res: TxResult, expected: launchpad::errors::LaunchpadError) {
    use solana_transaction::TransactionError;
    let code = 6000 + expected as u32;
    match res {
        Ok(_) => panic!("expected error {expected:?}, transaction succeeded"),
        Err(e) => match &e.err {
            TransactionError::InstructionError(_, err) => {
                let msg = format!("{err:?}");
                assert!(
                    msg.contains(&format!("Custom({code})")),
                    "expected {expected:?} ({code}), got {msg}\n{}",
                    e.meta.pretty_logs()
                );
            }
            other => panic!("expected {expected:?}, got {other:?}"),
        },
    }
}

/// Asserts that a transaction failed (any error).
pub fn assert_failed(res: TxResult) -> FailedTransactionMetadata {
    match res {
        Ok(meta) => panic!("expected failure, succeeded:\n{}", meta.pretty_logs()),
        Err(e) => e,
    }
}

/// Decodes the `emit_cpi!` events of type `E` from a transaction.
pub fn events<E: anchor_lang::Event + anchor_lang::AnchorDeserialize + Discriminator>(
    meta: &TransactionMetadata,
) -> Vec<E> {
    let tag = anchor_lang::event::EVENT_IX_TAG_LE;
    meta.inner_instructions
        .iter()
        .flatten()
        .filter_map(|ix| {
            let data = &ix.instruction.data;
            if data.len() < 16 || &data[..8] != tag || &data[8..16] != E::DISCRIMINATOR {
                return None;
            }
            E::try_from_slice(&data[16..]).ok()
        })
        .collect()
}

/// Reads the Token-2022 metadata stored in a mint.
pub fn token_metadata(
    env: &Env,
    mint: &Pubkey,
) -> anchor_spl::token_interface::spl_token_metadata_interface::state::TokenMetadata {
    use spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
    let acc = env.account(mint).unwrap();
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&acc.data).unwrap();
    state
        .get_variable_len_extension::<anchor_spl::token_interface::spl_token_metadata_interface::state::TokenMetadata>()
        .unwrap()
}
