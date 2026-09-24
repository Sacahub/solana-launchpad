import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { LAUNCHPAD_PROGRAM_ID, RAYDIUM_SEEDS, SEEDS, type RaydiumConfig } from "./constants.js";

export function findConfigPda(programId = LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.config], programId)[0];
}

export function findBondingCurvePda(mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.bondingCurve, mint.toBuffer()], programId)[0];
}

/** Token-2022 associated token account of the bonding curve (holds unsold tokens). */
export function findCurveVault(mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, findBondingCurvePda(mint, programId), true, TOKEN_2022_PROGRAM_ID);
}

export function findEventAuthority(programId = LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.eventAuthority], programId)[0];
}

export function findPoolCreatorPda(mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.poolCreator, mint.toBuffer()], programId)[0];
}

/** Address of the Raydium CPMM pool created for `mint` at graduation. */
export function findRaydiumPoolPda(mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.raydiumPool, mint.toBuffer()], programId)[0];
}

/** User's Token-2022 associated token account for a launchpad token. */
export function findUserTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
}

export interface RaydiumPoolAccounts {
  poolState: PublicKey;
  authority: PublicKey;
  lpMint: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  observation: PublicKey;
  /** True when the launchpad token is Raydium's token_0 (its key sorts before wSOL). */
  mintIsToken0: boolean;
  /** Pool vault holding the launchpad token. */
  tokenVault: PublicKey;
  /** Pool vault holding wSOL. */
  wsolVault: PublicKey;
}

const compareKeys = (a: PublicKey, b: PublicKey): number => Buffer.compare(a.toBuffer(), b.toBuffer());

/** Every Raydium CPMM account of the pool created for `mint`. */
export function findRaydiumPoolAccounts(
  mint: PublicKey,
  raydium: RaydiumConfig,
  programId = LAUNCHPAD_PROGRAM_ID,
): RaydiumPoolAccounts {
  const cpmm = raydium.cpmmProgram;
  const poolState = findRaydiumPoolPda(mint, programId);
  const mintIsToken0 = compareKeys(mint, NATIVE_MINT) < 0;
  const [token0Mint, token1Mint] = mintIsToken0 ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint];
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpmm)[0];
  const token0Vault = pda([RAYDIUM_SEEDS.vault, poolState.toBuffer(), token0Mint.toBuffer()]);
  const token1Vault = pda([RAYDIUM_SEEDS.vault, poolState.toBuffer(), token1Mint.toBuffer()]);
  return {
    poolState,
    authority: pda([RAYDIUM_SEEDS.authority]),
    lpMint: pda([RAYDIUM_SEEDS.lpMint, poolState.toBuffer()]),
    token0Mint,
    token1Mint,
    token0Vault,
    token1Vault,
    observation: pda([RAYDIUM_SEEDS.observation, poolState.toBuffer()]),
    mintIsToken0,
    tokenVault: mintIsToken0 ? token0Vault : token1Vault,
    wsolVault: mintIsToken0 ? token1Vault : token0Vault,
  };
}

/** Accounts of the migration's temporary token accounts. */
export function findPoolCreatorAccounts(mint: PublicKey, lpMint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID) {
  const poolCreator = findPoolCreatorPda(mint, programId);
  return {
    poolCreator,
    poolCreatorToken: getAssociatedTokenAddressSync(mint, poolCreator, true, TOKEN_2022_PROGRAM_ID),
    poolCreatorWsol: getAssociatedTokenAddressSync(NATIVE_MINT, poolCreator, true, TOKEN_PROGRAM_ID),
    poolCreatorLp: getAssociatedTokenAddressSync(lpMint, poolCreator, true, TOKEN_PROGRAM_ID),
  };
}
