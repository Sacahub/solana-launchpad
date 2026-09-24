import { PublicKey } from "@solana/web3.js";

import idl from "./idl/launchpad.json" with { type: "json" };

/** Program id declared in the IDL (`declare_id!` in the program). */
export const LAUNCHPAD_PROGRAM_ID = new PublicKey(idl.address);

export const SEEDS = {
  config: Buffer.from("config"),
  bondingCurve: Buffer.from("bonding_curve"),
  poolCreator: Buffer.from("pool_creator"),
  raydiumPool: Buffer.from("raydium_pool"),
  eventAuthority: Buffer.from("__event_authority"),
} as const;

export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = 10n ** BigInt(TOKEN_DECIMALS);
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS_DENOMINATOR = 10_000n;

export const MAX_NAME_LEN = 32;
export const MAX_SYMBOL_LEN = 10;
export const MAX_URI_LEN = 200;
export const MAX_TOTAL_FEE_BPS = 500;

/** Compute unit limits measured in tests, with headroom. */
export const COMPUTE_UNITS = {
  createToken: 120_000,
  /** create_token + first buy in the same transaction */
  createTokenAndBuy: 200_000,
  buy: 100_000,
  sell: 80_000,
  claim: 30_000,
  migrate: 350_000,
} as const;

/** Raydium CPMM deployment used for graduation. */
export interface RaydiumConfig {
  cpmmProgram: PublicKey;
  /** AMM config (fee tier) of the pools created at graduation. */
  ammConfig: PublicKey;
  /** wSOL account receiving Raydium's pool creation fee. */
  createPoolFee: PublicKey;
}

export const RAYDIUM: Record<"mainnet" | "devnet", RaydiumConfig> = {
  mainnet: {
    cpmmProgram: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
    // index 0: 0.25% trade fee
    ammConfig: new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2"),
    createPoolFee: new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8"),
  },
  devnet: {
    cpmmProgram: new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"),
    // index 0: 0.25% trade fee
    ammConfig: new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy"),
    createPoolFee: new PublicKey("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy"),
  },
};

export const RAYDIUM_SEEDS = {
  authority: Buffer.from("vault_and_lp_mint_auth_seed"),
  lpMint: Buffer.from("pool_lp_mint"),
  vault: Buffer.from("pool_vault"),
  observation: Buffer.from("observation"),
} as const;

/**
 * Default curve (same shape as pump.fun): 1B supply, 793.1M sold on the
 * curve, ~85 SOL raised at completion, 206.9M tokens paired in the DEX pool.
 */
export const DEFAULT_CURVE = {
  initialVirtualSolReserves: 30n * LAMPORTS_PER_SOL,
  initialVirtualTokenReserves: 1_073_000_000n * TOKEN_UNIT,
  initialRealTokenReserves: 793_100_000n * TOKEN_UNIT,
  tokenTotalSupply: 1_000_000_000n * TOKEN_UNIT,
} as const;

export const DEFAULT_FEES = {
  protocolFeeBps: 100,
  creatorFeeBps: 50,
  creationFeeLamports: 20_000_000n, // 0.02 SOL
  migrationFeeLamports: 500_000_000n, // 0.5 SOL
} as const;
