/**
 * Indexer + keeper against a local validator (`npm run localnet`).
 * The config must already be initialized (the SDK e2e test does it) or the
 * local wallet must be the program upgrade authority.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  COMPUTE_UNITS,
  DEFAULT_CURVE,
  DEFAULT_FEES,
  LaunchpadClient,
  RAYDIUM,
  solToLamports,
} from "@launchpad/sdk";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/api/app.js";
import { Db } from "../src/db/db.js";
import { EventBus, type LiveEvent } from "../src/indexer/bus.js";
import { Indexer } from "../src/indexer/indexer.js";
import { Keeper } from "../src/keeper.js";
import { LocalStorage } from "../src/metadata/storage.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(RPC_URL, "confirmed");
const client = new LaunchpadClient(connection);
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.ADMIN_KEYPAIR ?? join(homedir(), ".config/solana/id.json"), "utf8"))),
);

async function send(tx: VersionedTransaction, signers: Keypair[]) {
  tx.sign(signers);
  const signature = await connection.sendTransaction(tx);
  const latest = await connection.getLatestBlockhash("confirmed");
  const res = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (res.value.err) throw new Error(JSON.stringify(res.value.err));
  return signature;
}

const sendIxs = async (ixs: TransactionInstruction[], payer: Keypair, computeUnits?: number) =>
  send(await client.buildTransaction(ixs, payer.publicKey, { computeUnits }), [payer]);

async function fundedUser(sol: number) {
  const user = Keypair.generate();
  await sendIxs(
    [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: sol * LAMPORTS_PER_SOL })],
    admin,
  );
  return user;
}

async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("indexer + keeper (local validator)", () => {
  const db = new Db(":memory:");
  const bus = new EventBus();
  const live: LiveEvent[] = [];
  let indexer: Indexer;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await connection.getVersion();
    if (!(await connection.getAccountInfo(client.configAddress))) {
      const feeRecipient = Keypair.generate();
      await sendIxs(
        [
          SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: feeRecipient.publicKey, lamports: LAMPORTS_PER_SOL }),
          await client.initializeInstruction(admin.publicKey, {
            feeRecipient: feeRecipient.publicKey,
            ...DEFAULT_CURVE,
            ...DEFAULT_FEES,
            raydium: RAYDIUM.mainnet,
          }),
        ],
        admin,
      );
    }
    // Only index what happens from now on.
    const [latest] = await connection.getSignaturesForAddress(client.programId, { limit: 1 });
    bus.subscribe((e) => live.push(e));
    indexer = new Indexer(connection, db, bus, {
      programId: client.programId,
      pollIntervalMs: 500,
      startSignature: latest?.signature,
      log: () => undefined,
    });
    indexer.start();
    app = createApp({ db, bus, storage: new LocalStorage("/tmp/unused", "http://localhost") });
  });

  afterAll(async () => {
    await indexer?.stop();
    db.close();
  });

  it("indexes launches and trades, and the keeper graduates completed curves", async () => {
    const creator = await fundedUser(5);
    const { transaction, mint } = await client.createTokenTransaction({
      creator: creator.publicKey,
      name: "Indexed",
      symbol: "IDX",
      uri: "https://example.com/idx.json",
      initialBuyLamports: solToLamports(1),
    });
    await send(transaction, [creator]);
    const mintKey = mint.publicKey.toBase58();

    const trader = await fundedUser(200);
    const { instructions } = await client.buyInstructions({ buyer: trader.publicKey, mint: mint.publicKey, solAmount: solToLamports(3) });
    await sendIxs(instructions, trader, COMPUTE_UNITS.buy);
    const held = await client.fetchTokenBalance(trader.publicKey, mint.publicKey);
    const sell = await client.sellInstructions({ seller: trader.publicKey, mint: mint.publicKey, tokenAmount: held / 3n });
    await sendIxs(sell.instructions, trader, COMPUTE_UNITS.sell);

    const token = await until(
      () => db.getToken(mintKey),
      (t) => t !== null && t.tradeCount === 3,
    );
    const onChain = (await client.fetchBondingCurve(mint.publicKey))!;
    expect(token!.name).toBe("Indexed");
    expect(token!.creator).toBe(creator.publicKey.toBase58());
    expect(token!.realSolReserves).toBe(onChain.realSolReserves.toString());
    expect(token!.realTokenReserves).toBe(onChain.realTokenReserves.toString());

    const res = await app.request(`/api/tokens/${mintKey}/trades`);
    const { trades } = (await res.json()) as { trades: { isBuy: boolean; trader: string }[] };
    expect(trades.map((t) => t.isBuy)).toEqual([false, true, true]);
    expect(trades[0].trader).toBe(trader.publicKey.toBase58());
    expect(live.filter((e) => e.mint === mintKey).map((e) => e.type)).toEqual(["tokenCreated", "trade", "trade", "trade"]);

    // Complete the curve, the keeper migrates it.
    const whale = await fundedUser(200);
    const complete = await client.buyInstructions({ buyer: whale.publicKey, mint: mint.publicKey, solAmount: solToLamports(150) });
    await sendIxs(complete.instructions, whale, COMPUTE_UNITS.buy);
    await until(() => db.getToken(mintKey)!.status, (s) => s === "complete");

    const keeperWallet = await fundedUser(1);
    const keeper = new Keeper(client, keeperWallet, {
      intervalMs: 60_000,
      collectFeesMinLamports: 0n,
      priorityFeeMicroLamports: 0,
      log: () => undefined,
    });
    const result = await keeper.tick();
    expect(result.migrated).toContain(mintKey);

    const migrated = await until(() => db.getToken(mintKey)!, (t) => t.status === "migrated");
    expect(migrated.raydiumPool).toBe((await client.fetchBondingCurve(mint.publicKey))!.raydiumPool!.toBase58());
    expect(db.getGraduation(mintKey)!.pool).toBe(migrated.raydiumPool);
    // The keeper only paid transaction fees.
    const keeperBalance = await connection.getBalance(keeperWallet.publicKey);
    expect(LAMPORTS_PER_SOL - keeperBalance).toBeLessThan(100_000);
  });
});
