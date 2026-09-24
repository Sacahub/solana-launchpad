import type { PublicKey } from "@solana/web3.js";

import type { RaydiumConfig } from "./constants.js";
import type { CurveReserves } from "./math.js";

export type CurveStatus = "trading" | "complete" | "migrated";

export interface ConfigAccount {
  admin: PublicKey;
  pendingAdmin: PublicKey | null;
  feeRecipient: PublicKey;
  initialVirtualSolReserves: bigint;
  initialVirtualTokenReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
  creationFeeLamports: bigint;
  migrationFeeLamports: bigint;
  raydium: RaydiumConfig;
  createPaused: boolean;
  tradingPaused: boolean;
}

export interface BondingCurveAccount extends CurveReserves {
  address: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenTotalSupply: bigint;
  protocolFees: bigint;
  creatorFees: bigint;
  status: CurveStatus;
  /** Unix timestamp (seconds). */
  createdAt: number;
  completedAt: number | null;
  raydiumPool: PublicKey | null;
}

/** Values accepted by `initialize` / `update_config`. */
export interface ConfigParams {
  feeRecipient: PublicKey;
  initialVirtualSolReserves: bigint;
  initialVirtualTokenReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
  creationFeeLamports: bigint;
  migrationFeeLamports: bigint;
  raydium: RaydiumConfig;
}

export interface TokenCreatedEvent {
  mint: PublicKey;
  bondingCurve: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  timestamp: number;
}

export interface TradeEvent {
  mint: PublicKey;
  trader: PublicKey;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  timestamp: number;
}

export interface CurveCompletedEvent {
  mint: PublicKey;
  realSolReserves: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  timestamp: number;
}

export interface MigratedEvent {
  mint: PublicKey;
  pool: PublicKey;
  lpMint: PublicKey;
  poolSolAmount: bigint;
  poolTokenAmount: bigint;
  burnedTokenAmount: bigint;
  burnedLpAmount: bigint;
  protocolAmount: bigint;
  timestamp: number;
}

export interface CreatorFeesClaimedEvent {
  mint: PublicKey;
  creator: PublicKey;
  amount: bigint;
}

export interface ProtocolFeesCollectedEvent {
  mint: PublicKey;
  feeRecipient: PublicKey;
  amount: bigint;
}

export interface ConfigUpdatedEvent {
  admin: PublicKey;
  feeRecipient: PublicKey;
  protocolFeeBps: number;
  creatorFeeBps: number;
  createPaused: boolean;
  tradingPaused: boolean;
}

export type LaunchpadEvent =
  | { name: "tokenCreated"; data: TokenCreatedEvent }
  | { name: "trade"; data: TradeEvent }
  | { name: "curveCompleted"; data: CurveCompletedEvent }
  | { name: "migrated"; data: MigratedEvent }
  | { name: "creatorFeesClaimed"; data: CreatorFeesClaimedEvent }
  | { name: "protocolFeesCollected"; data: ProtocolFeesCollectedEvent }
  | { name: "configUpdated"; data: ConfigUpdatedEvent };

export type LaunchpadEventName = LaunchpadEvent["name"];
