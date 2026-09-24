/** Conversions between Anchor's decoded values (BN, enum objects) and SDK types. */
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import type { BondingCurveAccount, ConfigAccount, CurveStatus } from "./types.js";

export type Numberish = bigint | number | string | BN;

export const toBigInt = (value: Numberish): bigint => {
  if (typeof value === "bigint") return value;
  if (BN.isBN(value)) return BigInt(value.toString());
  return BigInt(value);
};

export const toBN = (value: Numberish): BN => new BN(toBigInt(value).toString());

const DEFAULT_KEY = PublicKey.default.toBase58();
export const optionalKey = (key: PublicKey): PublicKey | null =>
  key.toBase58() === DEFAULT_KEY ? null : key;

/** Recursively converts BN values to bigint (for decoded events and accounts). */
export function normalize<T>(value: unknown): T {
  if (BN.isBN(value)) return BigInt(value.toString()) as T;
  if (value instanceof PublicKey || value === null || typeof value !== "object") return value as T;
  if (Array.isArray(value)) return value.map((v) => normalize(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
  return out as T;
}

export const timestampOf = (value: unknown): number => Number(toBigInt(value as Numberish));

export function curveStatusOf(status: Record<string, unknown>): CurveStatus {
  const key = Object.keys(status)[0];
  if (key === "trading" || key === "complete" || key === "migrated") return key;
  throw new Error(`unknown curve status ${key}`);
}

// Shapes produced by the Anchor coder (camelCase, BN numbers).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export function bondingCurveFromRaw(address: PublicKey, raw: Raw): BondingCurveAccount {
  const completedAt = timestampOf(raw.completedAt);
  return {
    address,
    mint: raw.mint,
    creator: raw.creator,
    virtualSolReserves: toBigInt(raw.virtualSolReserves),
    virtualTokenReserves: toBigInt(raw.virtualTokenReserves),
    realSolReserves: toBigInt(raw.realSolReserves),
    realTokenReserves: toBigInt(raw.realTokenReserves),
    tokenTotalSupply: toBigInt(raw.tokenTotalSupply),
    protocolFees: toBigInt(raw.protocolFees),
    creatorFees: toBigInt(raw.creatorFees),
    status: curveStatusOf(raw.status),
    createdAt: timestampOf(raw.createdAt),
    completedAt: completedAt === 0 ? null : completedAt,
    raydiumPool: optionalKey(raw.raydiumPool),
  };
}

export function configFromRaw(raw: Raw): ConfigAccount {
  return {
    admin: raw.admin,
    pendingAdmin: optionalKey(raw.pendingAdmin),
    feeRecipient: raw.feeRecipient,
    initialVirtualSolReserves: toBigInt(raw.initialVirtualSolReserves),
    initialVirtualTokenReserves: toBigInt(raw.initialVirtualTokenReserves),
    initialRealTokenReserves: toBigInt(raw.initialRealTokenReserves),
    tokenTotalSupply: toBigInt(raw.tokenTotalSupply),
    protocolFeeBps: raw.protocolFeeBps,
    creatorFeeBps: raw.creatorFeeBps,
    creationFeeLamports: toBigInt(raw.creationFeeLamports),
    migrationFeeLamports: toBigInt(raw.migrationFeeLamports),
    raydium: {
      cpmmProgram: raw.raydiumCpmmProgram,
      ammConfig: raw.raydiumAmmConfig,
      createPoolFee: raw.raydiumCreatePoolFee,
    },
    createPaused: raw.createPaused,
    tradingPaused: raw.tradingPaused,
  };
}
