import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CURVE,
  applySlippageDown,
  applySlippageUp,
  bondingProgress,
  lamportsToSol,
  marketCapSol,
  quoteBuy,
  quoteSell,
  solCostForTokens,
  solToLamports,
  spotPriceSol,
  tokensToUnits,
  unitsToTokens,
  type CurveReserves,
  type Fees,
} from "../src/index.js";

const FEES: Fees = { protocolFeeBps: 100, creatorFeeBps: 50 };
const START: CurveReserves = {
  virtualSolReserves: DEFAULT_CURVE.initialVirtualSolReserves,
  virtualTokenReserves: DEFAULT_CURVE.initialVirtualTokenReserves,
  realSolReserves: 0n,
  realTokenReserves: DEFAULT_CURVE.initialRealTokenReserves,
};

interface Vector {
  curve: Record<keyof CurveReserves, string>;
  fees: Fees;
  budget: string;
  tokens: string;
  buy: Record<string, string | boolean> | null;
  sell: Record<string, string> | null;
}

const curveOf = (c: Vector["curve"]): CurveReserves => ({
  virtualSolReserves: BigInt(c.virtualSolReserves),
  virtualTokenReserves: BigInt(c.virtualTokenReserves),
  realSolReserves: BigInt(c.realSolReserves),
  realTokenReserves: BigInt(c.realTokenReserves),
});

describe("parity with the on-chain math", () => {
  const vectors: Vector[] = JSON.parse(
    readFileSync(join(__dirname, "../../tests/fixtures/math_vectors.json"), "utf8"),
  );

  it("has vectors", () => expect(vectors.length).toBeGreaterThan(100));

  it("reproduces every buy quote exactly", () => {
    for (const v of vectors) {
      const run = () => quoteBuy(curveOf(v.curve), BigInt(v.budget), v.fees);
      if (!v.buy) {
        expect(run).toThrow();
        continue;
      }
      const q = run();
      expect({
        solAmount: q.solAmount.toString(),
        tokenAmount: q.tokenAmount.toString(),
        protocolFee: q.protocolFee.toString(),
        creatorFee: q.creatorFee.toString(),
        totalCost: q.totalCost.toString(),
        completesCurve: q.completesCurve,
      }).toEqual(v.buy);
    }
  });

  it("reproduces every sell quote exactly", () => {
    for (const v of vectors) {
      const run = () => quoteSell(curveOf(v.curve), BigInt(v.tokens), v.fees);
      if (!v.sell) {
        expect(run).toThrow();
        continue;
      }
      const q = run();
      expect({
        solAmount: q.solAmount.toString(),
        protocolFee: q.protocolFee.toString(),
        creatorFee: q.creatorFee.toString(),
        solOut: q.solOut.toString(),
      }).toEqual(v.sell);
    }
  });
});

describe("curve helpers", () => {
  it("prices the first token at ~2.8e-8 SOL and the market cap at ~28 SOL", () => {
    expect(spotPriceSol(START)).toBeCloseTo(2.7959e-8, 11);
    expect(marketCapSol(START, DEFAULT_CURVE.tokenTotalSupply)).toBeCloseTo(27.96, 1);
    expect(bondingProgress(START, DEFAULT_CURVE.initialRealTokenReserves)).toBe(0);
  });

  it("completes at ~85 SOL raised", () => {
    const q = quoteBuy(START, solToLamports(200), FEES);
    expect(q.completesCurve).toBe(true);
    expect(q.tokenAmount).toBe(DEFAULT_CURVE.initialRealTokenReserves);
    expect(Number(lamportsToSol(q.solAmount))).toBeCloseTo(85.005, 2);
  });

  it("solCostForTokens buys at least the requested tokens with the smallest budget", () => {
    for (const tokens of [1n, 1_000n, tokensToUnits("12345.678901"), tokensToUnits(50_000_000)]) {
      const budget = solCostForTokens(START, tokens, FEES);
      expect(quoteBuy(START, budget, FEES).tokenAmount >= tokens).toBe(true);
      if (budget > 1n) {
        const less = (() => {
          try {
            return quoteBuy(START, budget - 1n, FEES).tokenAmount;
          } catch {
            return 0n;
          }
        })();
        expect(less < tokens).toBe(true);
      }
    }
  });

  it("slippage helpers round conservatively", () => {
    expect(applySlippageDown(10_000n, 100)).toBe(9_900n);
    expect(applySlippageUp(10_000n, 100)).toBe(10_100n);
    expect(applySlippageUp(1n, 1)).toBe(2n);
  });

  it("converts decimal amounts without float errors", () => {
    expect(solToLamports("0.1")).toBe(100_000_000n);
    expect(solToLamports("1.000000001")).toBe(1_000_000_001n);
    expect(tokensToUnits("0.000001")).toBe(1n);
    expect(unitsToTokens(1_500_000n)).toBe("1.5");
    expect(lamportsToSol(1_000_000_000n)).toBe("1");
    expect(() => solToLamports("1.0000000001")).toThrow();
    expect(() => solToLamports("-1")).toThrow();
  });
});
