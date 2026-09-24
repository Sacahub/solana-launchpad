import { Program, type Idl } from "@anchor-lang/core";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getTokenMetadata,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Commitment,
  type Connection,
  type GetProgramAccountsFilter,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";

import {
  COMPUTE_UNITS,
  LAUNCHPAD_PROGRAM_ID,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  MAX_URI_LEN,
} from "./constants.js";
import { bondingCurveFromRaw, configFromRaw, toBN, type Numberish } from "./convert.js";
import { parseTransactionEvents } from "./events.js";
import idlJson from "./idl/launchpad.json" with { type: "json" };
import type { Launchpad } from "./idl/launchpad.js";
import {
  applySlippageDown,
  bondingProgress,
  marketCapSol,
  quoteBuy,
  quoteSell,
  spotPriceSol,
  type BuyQuote,
  type Fees,
  type SellQuote,
} from "./math.js";
import {
  findBondingCurvePda,
  findConfigPda,
  findCurveVault,
  findEventAuthority,
  findPoolCreatorAccounts,
  findRaydiumPoolAccounts,
  findUserTokenAccount,
} from "./pda.js";
import type {
  BondingCurveAccount,
  ConfigAccount,
  ConfigParams,
  CurveStatus,
  LaunchpadEvent,
} from "./types.js";

export interface LaunchpadClientOptions {
  programId?: PublicKey;
  commitment?: Commitment;
}

export interface TransactionOptions {
  /** Compute unit limit; defaults depend on the instruction. */
  computeUnits?: number;
  /** Priority fee in micro-lamports per compute unit. */
  priorityFeeMicroLamports?: number;
  lookupTables?: AddressLookupTableAccount[];
}

export interface CurveMetrics {
  /** Spot price in SOL per token. */
  priceSol: number;
  marketCapSol: number;
  /** 0 → 100 */
  progress: number;
  /** SOL in the curve reserves. */
  solRaised: bigint;
}

const STATUS_OFFSET = 8 + 32 + 32 + 7 * 8;
const CREATOR_OFFSET = 8 + 32;
const STATUS_BYTE: Record<CurveStatus, number> = { trading: 0, complete: 1, migrated: 2 };

/**
 * High level client for the launchpad program.
 *
 * Instruction builders return plain `TransactionInstruction`s so they can be
 * composed freely; `buildTransaction` turns them into a v0 transaction ready
 * to be signed by a wallet adapter.
 */
export class LaunchpadClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly program: Program<Launchpad>;
  readonly commitment: Commitment;

  constructor(connection: Connection, options: LaunchpadClientOptions = {}) {
    this.connection = connection;
    this.programId = options.programId ?? LAUNCHPAD_PROGRAM_ID;
    this.commitment = options.commitment ?? "confirmed";
    const idl = { ...(idlJson as Idl), address: this.programId.toBase58() };
    this.program = new Program<Launchpad>(idl as unknown as Launchpad, { connection });
  }

  // ------------------------------------------------------------------ PDAs

  get configAddress(): PublicKey {
    return findConfigPda(this.programId);
  }

  bondingCurveAddress(mint: PublicKey): PublicKey {
    return findBondingCurvePda(mint, this.programId);
  }

  // ----------------------------------------------------------------- reads

  async fetchConfig(): Promise<ConfigAccount> {
    const raw = await this.program.account.config.fetch(this.configAddress, this.commitment);
    return configFromRaw(raw);
  }

  async fetchBondingCurve(mint: PublicKey): Promise<BondingCurveAccount | null> {
    const address = this.bondingCurveAddress(mint);
    const raw = await this.program.account.bondingCurve.fetchNullable(address, this.commitment);
    return raw ? bondingCurveFromRaw(address, raw) : null;
  }

  /** All bonding curves, optionally filtered by status and/or creator. */
  async fetchBondingCurves(filter: { status?: CurveStatus; creator?: PublicKey } = {}): Promise<BondingCurveAccount[]> {
    const filters: GetProgramAccountsFilter[] = [];
    if (filter.status) {
      filters.push({
        memcmp: {
          offset: STATUS_OFFSET,
          bytes: Buffer.from([STATUS_BYTE[filter.status]]).toString("base64"),
          encoding: "base64",
        },
      });
    }
    if (filter.creator) {
      filters.push({ memcmp: { offset: CREATOR_OFFSET, bytes: filter.creator.toBase58() } });
    }
    const all = await this.program.account.bondingCurve.all(filters);
    return all.map((a) => bondingCurveFromRaw(a.publicKey, a.account));
  }

  /** Name, symbol and URI stored in the Token-2022 mint. */
  async fetchTokenMetadata(mint: PublicKey): Promise<{ name: string; symbol: string; uri: string } | null> {
    const metadata = await getTokenMetadata(this.connection, mint, this.commitment, TOKEN_2022_PROGRAM_ID);
    return metadata ? { name: metadata.name, symbol: metadata.symbol, uri: metadata.uri } : null;
  }

  /** Token balance (base units) of `owner` for a launchpad token. */
  async fetchTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const ata = findUserTokenAccount(owner, mint);
    const info = await this.connection.getTokenAccountBalance(ata, this.commitment).catch(() => null);
    return info ? BigInt(info.value.amount) : 0n;
  }

  // ---------------------------------------------------------------- quotes

  static fees(config: ConfigAccount): Fees {
    return { protocolFeeBps: config.protocolFeeBps, creatorFeeBps: config.creatorFeeBps };
  }

  static metrics(curve: BondingCurveAccount, config: Pick<ConfigAccount, "initialRealTokenReserves">): CurveMetrics {
    return {
      priceSol: spotPriceSol(curve),
      marketCapSol: marketCapSol(curve, curve.tokenTotalSupply),
      progress: curve.status === "trading" ? bondingProgress(curve, config.initialRealTokenReserves) : 100,
      solRaised: curve.realSolReserves,
    };
  }

  async quoteBuy(mint: PublicKey, solAmount: Numberish): Promise<BuyQuote> {
    const [curve, config] = await Promise.all([this.requireTradingCurve(mint), this.fetchConfig()]);
    return quoteBuy(curve, BigInt(toBN(solAmount).toString()), LaunchpadClient.fees(config));
  }

  async quoteSell(mint: PublicKey, tokenAmount: Numberish): Promise<SellQuote> {
    const [curve, config] = await Promise.all([this.requireTradingCurve(mint), this.fetchConfig()]);
    return quoteSell(curve, BigInt(toBN(tokenAmount).toString()), LaunchpadClient.fees(config));
  }

  // ---------------------------------------------------------- instructions

  /**
   * Instructions launching a token, optionally followed by the creator's
   * first buy in the same transaction (no one can buy before the creator).
   * The `mint` keypair must sign the transaction.
   */
  async createTokenInstructions(params: {
    creator: PublicKey;
    mint: PublicKey;
    name: string;
    symbol: string;
    uri: string;
    /** Lamports (fees included) spent on the creator's first buy. */
    initialBuyLamports?: Numberish;
    slippageBps?: number;
    config?: ConfigAccount;
  }): Promise<{ instructions: TransactionInstruction[]; initialBuy: BuyQuote | null }> {
    validateMetadata(params.name, params.symbol, params.uri);
    const config = params.config ?? (await this.fetchConfig());
    if (config.createPaused) throw new Error("token creation is paused");
    const curve = this.bondingCurveAddress(params.mint);

    const create = await this.program.methods
      .createToken(params.name, params.symbol, params.uri)
      .accountsStrict({
        creator: params.creator,
        config: this.configAddress,
        mint: params.mint,
        bondingCurve: curve,
        curveVault: findCurveVault(params.mint, this.programId),
        feeRecipient: config.feeRecipient,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();

    const initialBuyLamports = params.initialBuyLamports ? BigInt(toBN(params.initialBuyLamports).toString()) : 0n;
    if (initialBuyLamports === 0n) return { instructions: [create], initialBuy: null };

    // The curve does not exist yet: quote against the initial reserves.
    const initialBuy = quoteBuy(
      {
        virtualSolReserves: config.initialVirtualSolReserves,
        virtualTokenReserves: config.initialVirtualTokenReserves,
        realSolReserves: 0n,
        realTokenReserves: config.initialRealTokenReserves,
      },
      initialBuyLamports,
      LaunchpadClient.fees(config),
    );
    const buy = await this.buyInstruction({
      buyer: params.creator,
      mint: params.mint,
      solAmount: initialBuyLamports,
      minTokenAmount: applySlippageDown(initialBuy.tokenAmount, params.slippageBps ?? 0),
    });
    return { instructions: [create, buy], initialBuy };
  }

  /** Raw `buy` instruction. */
  async buyInstruction(params: {
    buyer: PublicKey;
    mint: PublicKey;
    solAmount: Numberish;
    minTokenAmount: Numberish;
  }): Promise<TransactionInstruction> {
    const curve = this.bondingCurveAddress(params.mint);
    return this.program.methods
      .buy(toBN(params.solAmount), toBN(params.minTokenAmount))
      .accountsStrict({
        buyer: params.buyer,
        config: this.configAddress,
        bondingCurve: curve,
        mint: params.mint,
        curveVault: findCurveVault(params.mint, this.programId),
        buyerTokenAccount: findUserTokenAccount(params.buyer, params.mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
  }

  /** Quotes and builds a buy spending `solAmount` lamports (fees included). */
  async buyInstructions(params: {
    buyer: PublicKey;
    mint: PublicKey;
    solAmount: Numberish;
    /** Default 1% */
    slippageBps?: number;
  }): Promise<{ instructions: TransactionInstruction[]; quote: BuyQuote }> {
    const quote = await this.quoteBuy(params.mint, params.solAmount);
    const ix = await this.buyInstruction({
      buyer: params.buyer,
      mint: params.mint,
      solAmount: params.solAmount,
      minTokenAmount: applySlippageDown(quote.tokenAmount, params.slippageBps ?? 100),
    });
    return { instructions: [ix], quote };
  }

  /** Raw `sell` instruction. */
  async sellInstruction(params: {
    seller: PublicKey;
    mint: PublicKey;
    tokenAmount: Numberish;
    minSolAmount: Numberish;
    /** Defaults to the seller's associated token account. */
    tokenAccount?: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .sell(toBN(params.tokenAmount), toBN(params.minSolAmount))
      .accountsStrict({
        seller: params.seller,
        config: this.configAddress,
        bondingCurve: this.bondingCurveAddress(params.mint),
        mint: params.mint,
        curveVault: findCurveVault(params.mint, this.programId),
        sellerTokenAccount: params.tokenAccount ?? findUserTokenAccount(params.seller, params.mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
  }

  /** Quotes and builds a sell of exactly `tokenAmount` tokens. */
  async sellInstructions(params: {
    seller: PublicKey;
    mint: PublicKey;
    tokenAmount: Numberish;
    slippageBps?: number;
  }): Promise<{ instructions: TransactionInstruction[]; quote: SellQuote }> {
    const quote = await this.quoteSell(params.mint, params.tokenAmount);
    const ix = await this.sellInstruction({
      seller: params.seller,
      mint: params.mint,
      tokenAmount: params.tokenAmount,
      minSolAmount: applySlippageDown(quote.solOut, params.slippageBps ?? 100),
    });
    return { instructions: [ix], quote };
  }

  async claimCreatorFeesInstruction(params: { creator: PublicKey; mint: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .claimCreatorFees()
      .accountsStrict({
        creator: params.creator,
        bondingCurve: this.bondingCurveAddress(params.mint),
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
  }

  async collectProtocolFeesInstruction(params: { mint: PublicKey; feeRecipient?: PublicKey }): Promise<TransactionInstruction> {
    const feeRecipient = params.feeRecipient ?? (await this.fetchConfig()).feeRecipient;
    return this.program.methods
      .collectProtocolFees()
      .accountsStrict({
        config: this.configAddress,
        bondingCurve: this.bondingCurveAddress(params.mint),
        feeRecipient,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
  }

  /** Instructions graduating a completed curve to Raydium (anyone can send them). */
  async migrateInstructions(params: {
    payer: PublicKey;
    mint: PublicKey;
    config?: ConfigAccount;
  }): Promise<TransactionInstruction[]> {
    const config = params.config ?? (await this.fetchConfig());
    const pool = findRaydiumPoolAccounts(params.mint, config.raydium, this.programId);
    const creator = findPoolCreatorAccounts(params.mint, pool.lpMint, this.programId);
    const migrate = await this.program.methods
      .migrate()
      .accountsStrict({
        payer: params.payer,
        config: this.configAddress,
        bondingCurve: this.bondingCurveAddress(params.mint),
        mint: params.mint,
        curveVault: findCurveVault(params.mint, this.programId),
        poolCreator: creator.poolCreator,
        poolCreatorToken: creator.poolCreatorToken,
        poolCreatorWsol: creator.poolCreatorWsol,
        poolCreatorLp: creator.poolCreatorLp,
        wsolMint: NATIVE_MINT,
        feeRecipient: config.feeRecipient,
        raydiumProgram: config.raydium.cpmmProgram,
        ammConfig: config.raydium.ammConfig,
        raydiumAuthority: pool.authority,
        poolState: pool.poolState,
        lpMint: pool.lpMint,
        token0Vault: pool.token0Vault,
        token1Vault: pool.token1Vault,
        createPoolFee: config.raydium.createPoolFee,
        observationState: pool.observation,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.migrate }), migrate];
  }

  // ----------------------------------------------------------------- admin

  async initializeInstruction(admin: PublicKey, params: ConfigParams): Promise<TransactionInstruction> {
    const programData = PublicKey.findProgramAddressSync(
      [this.programId.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0];
    return this.program.methods
      .initialize(configParamsToRaw(params))
      .accountsStrict({
        admin,
        config: this.configAddress,
        launchpadProgram: this.programId,
        programData,
        systemProgram: SystemProgram.programId,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
  }

  async updateConfigInstruction(admin: PublicKey, params: ConfigParams): Promise<TransactionInstruction> {
    return this.program.methods
      .updateConfig(configParamsToRaw(params))
      .accountsStrict(this.adminAccounts(admin))
      .instruction();
  }

  async setPausedInstruction(admin: PublicKey, createPaused: boolean, tradingPaused: boolean): Promise<TransactionInstruction> {
    return this.program.methods
      .setPaused(createPaused, tradingPaused)
      .accountsStrict(this.adminAccounts(admin))
      .instruction();
  }

  async transferAdminInstruction(admin: PublicKey, newAdmin: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .transferAdmin(newAdmin)
      .accountsStrict(this.adminAccounts(admin))
      .instruction();
  }

  async acceptAdminInstruction(newAdmin: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .acceptAdmin()
      .accountsStrict({
        newAdmin,
        config: this.configAddress,
        eventAuthority: findEventAuthority(this.programId),
        program: this.programId,
      })
      .instruction();
  }

  private adminAccounts(admin: PublicKey) {
    return {
      admin,
      config: this.configAddress,
      eventAuthority: findEventAuthority(this.programId),
      program: this.programId,
    };
  }

  // ---------------------------------------------------------- transactions

  /**
   * Builds an unsigned v0 transaction (compute budget included). Sign it with
   * the wallet, plus the mint keypair for `create_token`.
   */
  async buildTransaction(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    options: TransactionOptions = {},
  ): Promise<VersionedTransaction> {
    const budget: TransactionInstruction[] = [];
    const hasLimit = instructions.some(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2,
    );
    if (!hasLimit && options.computeUnits) {
      budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnits }));
    }
    if (options.priorityFeeMicroLamports) {
      budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: options.priorityFeeMicroLamports }));
    }
    const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [...budget, ...instructions],
    }).compileToV0Message(options.lookupTables);
    return new VersionedTransaction(message);
  }

  /**
   * One-call helper for the launch flow: generates the mint keypair (or uses
   * the provided one, e.g. a vanity address), builds and partially signs the
   * transaction. The wallet only needs to add the creator's signature.
   */
  async createTokenTransaction(params: {
    creator: PublicKey;
    name: string;
    symbol: string;
    uri: string;
    initialBuyLamports?: Numberish;
    slippageBps?: number;
    mint?: Keypair;
    options?: TransactionOptions;
  }): Promise<{ transaction: VersionedTransaction; mint: Keypair; initialBuy: BuyQuote | null }> {
    const mint = params.mint ?? Keypair.generate();
    const { instructions, initialBuy } = await this.createTokenInstructions({ ...params, mint: mint.publicKey });
    const transaction = await this.buildTransaction(instructions, params.creator, {
      computeUnits: initialBuy ? COMPUTE_UNITS.createTokenAndBuy : COMPUTE_UNITS.createToken,
      ...params.options,
    });
    transaction.sign([mint]);
    return { transaction, mint, initialBuy };
  }

  // ---------------------------------------------------------------- events

  parseEvents(tx: VersionedTransactionResponse): LaunchpadEvent[] {
    return parseTransactionEvents(tx, this.programId);
  }

  async fetchTransactionEvents(signature: string): Promise<LaunchpadEvent[]> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: this.commitment === "finalized" ? "finalized" : "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return tx ? this.parseEvents(tx) : [];
  }

  // --------------------------------------------------------------- helpers

  private async requireTradingCurve(mint: PublicKey): Promise<BondingCurveAccount> {
    const curve = await this.fetchBondingCurve(mint);
    if (!curve) throw new Error(`no bonding curve for mint ${mint.toBase58()}`);
    if (curve.status !== "trading") {
      throw new Error(
        curve.status === "complete"
          ? "the bonding curve is complete and waiting for migration"
          : "the token graduated to Raydium: trade it on the DEX",
      );
    }
    return curve;
  }
}

export function validateMetadata(name: string, symbol: string, uri: string): void {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  if (!name.trim() || bytes(name) > MAX_NAME_LEN) throw new Error(`name must be 1-${MAX_NAME_LEN} bytes`);
  if (!symbol.trim() || bytes(symbol) > MAX_SYMBOL_LEN) throw new Error(`symbol must be 1-${MAX_SYMBOL_LEN} bytes`);
  if (!uri.trim() || bytes(uri) > MAX_URI_LEN) throw new Error(`uri must be 1-${MAX_URI_LEN} bytes`);
}

function configParamsToRaw(params: ConfigParams) {
  return {
    feeRecipient: params.feeRecipient,
    initialVirtualSolReserves: toBN(params.initialVirtualSolReserves),
    initialVirtualTokenReserves: toBN(params.initialVirtualTokenReserves),
    initialRealTokenReserves: toBN(params.initialRealTokenReserves),
    tokenTotalSupply: toBN(params.tokenTotalSupply),
    protocolFeeBps: params.protocolFeeBps,
    creatorFeeBps: params.creatorFeeBps,
    creationFeeLamports: toBN(params.creationFeeLamports),
    migrationFeeLamports: toBN(params.migrationFeeLamports),
    raydiumAmmConfig: params.raydium.ammConfig,
    raydiumCreatePoolFee: params.raydium.createPoolFee,
  };
}
