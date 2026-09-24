/**
 * Exact port of the on-chain curve math (`programs/launchpad/src/math.rs`).
 * All amounts are bigint: lamports for SOL, base units (6 decimals) for tokens.
 * Quotes computed here match the program to the unit.
 */
import { BPS_DENOMINATOR, LAMPORTS_PER_SOL, TOKEN_UNIT } from "./constants.js";

export interface Fees {
  protocolFeeBps: number;
  creatorFeeBps: number;
}

export interface CurveReserves {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

export interface BuyQuote {
  /** Lamports entering the curve reserves (fees excluded). */
  solAmount: bigint;
  /** Tokens received. */
  tokenAmount: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** Lamports paid in total (never above the budget). */
  totalCost: bigint;
  /** True when this buy takes the last tokens of the curve. */
  completesCurve: boolean;
  /** Price impact in basis points (spot price after vs before). */
  priceImpactBps: number;
}

export interface SellQuote {
  tokenAmount: bigint;
  /** Lamports leaving the curve reserves (fees included). */
  solAmount: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** Lamports received by the seller. */
  solOut: bigint;
  priceImpactBps: number;
}

export class LaunchpadMathError extends Error {}

const BPS = BPS_DENOMINATOR;

const ceilDiv = (a: bigint, b: bigint): bigint => {
  if (b <= 0n) throw new LaunchpadMathError("division by zero");
  return (a + b - 1n) / b;
};

const totalBps = (fees: Fees): bigint => BigInt(fees.protocolFeeBps) + BigInt(fees.creatorFeeBps);

/** Fee due on `amount`, rounded up. */
export function feeOn(amount: bigint, fees: Fees): bigint {
  return ceilDiv(amount * totalBps(fees), BPS);
}

/** Splits a fee between protocol and creator; dust goes to the protocol. */
export function splitFee(totalFee: bigint, fees: Fees): { protocolFee: bigint; creatorFee: bigint } {
  const bps = totalBps(fees);
  if (bps === 0n || totalFee === 0n) return { protocolFee: totalFee, creatorFee: 0n };
  const creatorFee = (totalFee * BigInt(fees.creatorFeeBps)) / bps;
  return { protocolFee: totalFee - creatorFee, creatorFee };
}

function impactBps(
  vsBefore: bigint,
  vtBefore: bigint,
  vsAfter: bigint,
  vtAfter: bigint,
): number {
  // (price_after / price_before - 1) in bps, price = vs / vt
  const num = vsAfter * vtBefore;
  const den = vsBefore * vtAfter;
  if (den === 0n) return 0;
  const diff = num > den ? num - den : den - num;
  return Number((diff * BPS) / den);
}

/**
 * Quotes a buy spending at most `solBudget` lamports (fees included).
 * Mirrors `math::quote_buy`: throws when the buy would receive zero tokens.
 */
export function quoteBuy(curve: CurveReserves, solBudget: bigint, fees: Fees): BuyQuote {
  if (solBudget <= 0n) throw new LaunchpadMathError("amount must be greater than zero");
  if (curve.realTokenReserves <= 0n) throw new LaunchpadMathError("the curve is complete");
  const vs = curve.virtualSolReserves;
  const vt = curve.virtualTokenReserves;
  const bps = totalBps(fees);

  let solAmount = (solBudget * BPS) / (BPS + bps);
  let feeTotal = solBudget - solAmount;
  let tokenAmount = (vt * solAmount) / (vs + solAmount);
  let completesCurve = false;

  if (tokenAmount >= curve.realTokenReserves) {
    tokenAmount = curve.realTokenReserves;
    solAmount = ceilDiv(vs * tokenAmount, vt - tokenAmount);
    feeTotal = ceilDiv(solAmount * bps, BPS);
    completesCurve = true;
  }
  if (tokenAmount === 0n) throw new LaunchpadMathError("amount too small");

  const { protocolFee, creatorFee } = splitFee(feeTotal, fees);
  return {
    solAmount,
    tokenAmount,
    protocolFee,
    creatorFee,
    totalCost: solAmount + feeTotal,
    completesCurve,
    priceImpactBps: impactBps(vs, vt, vs + solAmount, vt - tokenAmount),
  };
}

/** Quotes selling exactly `tokenAmount` tokens. Mirrors `math::quote_sell`. */
export function quoteSell(curve: CurveReserves, tokenAmount: bigint, fees: Fees): SellQuote {
  if (tokenAmount <= 0n) throw new LaunchpadMathError("amount must be greater than zero");
  const vs = curve.virtualSolReserves;
  const vt = curve.virtualTokenReserves;

  const solAmount = (vs * tokenAmount) / (vt + tokenAmount);
  if (solAmount > curve.realSolReserves) {
    throw new LaunchpadMathError("insufficient SOL reserves in the curve");
  }
  const feeTotal = feeOn(solAmount, fees);
  const solOut = solAmount - feeTotal;
  if (solOut <= 0n) throw new LaunchpadMathError("amount too small");
  const { protocolFee, creatorFee } = splitFee(feeTotal, fees);
  return {
    tokenAmount,
    solAmount,
    protocolFee,
    creatorFee,
    solOut,
    priceImpactBps: impactBps(vs, vt, vs - solAmount, vt + tokenAmount),
  };
}

/**
 * SOL budget (fees included) needed to buy exactly `tokenAmount` tokens.
 * Pass the result to `buy` as `solAmount`, the program then delivers at least
 * `tokenAmount` tokens.
 */
export function solCostForTokens(curve: CurveReserves, tokenAmount: bigint, fees: Fees): bigint {
  if (tokenAmount <= 0n) throw new LaunchpadMathError("amount must be greater than zero");
  const tokens = tokenAmount > curve.realTokenReserves ? curve.realTokenReserves : tokenAmount;
  const vs = curve.virtualSolReserves;
  const vt = curve.virtualTokenReserves;
  // smallest net amount n with floor(vt * n / (vs + n)) >= tokens
  const net = ceilDiv(vs * tokens, vt - tokens);
  // smallest budget b with floor(b * BPS / (BPS + bps)) >= net
  const bps = totalBps(fees);
  return ceilDiv(net * (BPS + bps), BPS);
}

/**
 * SOL (fees excluded) still needed to buy every remaining curve token, i.e.
 * what separates the curve from graduation (`math::sol_to_complete`).
 */
export function solToComplete(curve: CurveReserves): bigint {
  if (curve.realTokenReserves === 0n) return 0n;
  return ceilDiv(
    curve.virtualSolReserves * curve.realTokenReserves,
    curve.virtualTokenReserves - curve.realTokenReserves,
  );
}

/** Tokens paired with `solAmount` in the DEX pool at graduation (`math::pool_token_amount`). */
export function poolTokenAmount(curve: CurveReserves, solAmount: bigint, availableTokens: bigint): bigint {
  const tokens = (solAmount * curve.virtualTokenReserves) / curve.virtualSolReserves;
  return tokens < availableTokens ? tokens : availableTokens;
}

/** Spot price in SOL per whole token (floating point, for display only). */
export function spotPriceSol(curve: CurveReserves): number {
  // lamports per base unit * (TOKEN_UNIT / LAMPORTS_PER_SOL)
  const scale = 10n ** 18n;
  const lamportsPerUnitScaled = (curve.virtualSolReserves * scale) / curve.virtualTokenReserves;
  return (Number(lamportsPerUnitScaled) / Number(scale)) * (Number(TOKEN_UNIT) / Number(LAMPORTS_PER_SOL));
}

/** Market cap in SOL (spot price × total supply), for display. */
export function marketCapSol(curve: CurveReserves, tokenTotalSupply: bigint): number {
  return spotPriceSol(curve) * (Number(tokenTotalSupply) / Number(TOKEN_UNIT));
}

/** Bonding curve progress, 0 → 100 (%). */
export function bondingProgress(curve: CurveReserves, initialRealTokenReserves: bigint): number {
  if (initialRealTokenReserves === 0n) return 100;
  const sold = initialRealTokenReserves - curve.realTokenReserves;
  return Number((sold * 10_000n) / initialRealTokenReserves) / 100;
}

/** Applies a slippage tolerance downwards (minimum acceptable output). */
export function applySlippageDown(amount: bigint, slippageBps: number): bigint {
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

/** Applies a slippage tolerance upwards (maximum acceptable input). */
export function applySlippageUp(amount: bigint, slippageBps: number): bigint {
  return ceilDiv(amount * (BPS + BigInt(slippageBps)), BPS);
}

/** Converts a decimal SOL string/number into lamports without float rounding errors. */
export function solToLamports(sol: string | number): bigint {
  return decimalToUnits(String(sol), 9);
}

/** Converts a decimal token amount into base units. */
export function tokensToUnits(tokens: string | number): bigint {
  return decimalToUnits(String(tokens), 6);
}

export function lamportsToSol(lamports: bigint): string {
  return unitsToDecimal(lamports, 9);
}

export function unitsToTokens(units: bigint): string {
  return unitsToDecimal(units, 6);
}

function decimalToUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new LaunchpadMathError(`invalid amount: ${value}`);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new LaunchpadMathError(`too many decimals: ${value}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

function unitsToDecimal(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
