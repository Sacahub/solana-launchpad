import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  LAUNCHPAD_PROGRAM_ID,
  RAYDIUM,
  findConfigPda,
  findRaydiumPoolAccounts,
  findRaydiumPoolPda,
} from "../src/index.js";

describe("pda", () => {
  it("derives the config PDA of the program", () => {
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("config")], LAUNCHPAD_PROGRAM_ID);
    expect(findConfigPda().equals(expected)).toBe(true);
  });

  it("orders Raydium tokens like the program (token_0 < token_1)", () => {
    for (let i = 0; i < 50; i++) {
      const mint = Keypair.generate().publicKey;
      const pool = findRaydiumPoolAccounts(mint, RAYDIUM.mainnet);
      const cmp = Buffer.compare(pool.token0Mint.toBuffer(), pool.token1Mint.toBuffer());
      expect(cmp).toBeLessThan(0);
      expect(pool.mintIsToken0).toBe(pool.token0Mint.equals(mint));
      expect([pool.token0Mint, pool.token1Mint].some((k) => k.equals(NATIVE_MINT))).toBe(true);
      expect(pool.poolState.equals(findRaydiumPoolPda(mint))).toBe(true);
    }
  });
});
