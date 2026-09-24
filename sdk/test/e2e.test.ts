/**
 * End-to-end test against a local validator started with
 * `scripts/localnet.sh` (launchpad program + mainnet Raydium CPMM copy).
 *
 *   npm run localnet            # terminal 1
 *   npm run test:e2e -w sdk     # terminal 2
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  COMPUTE_UNITS,
  DEFAULT_CURVE,
  DEFAULT_FEES,
  LaunchpadClient,
  RAYDIUM,
  findRaydiumPoolAccounts,
  solToLamports,
  type ConfigParams,
  type LaunchpadEvent,
} from "../src/index.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(RPC_URL, "confirmed");
const client = new LaunchpadClient(connection);

const loadKeypair = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const admin = loadKeypair(process.env.ADMIN_KEYPAIR ?? join(homedir(), ".config/solana/id.json"));
const feeRecipient = Keypair.generate();

async function send(tx: VersionedTransaction, signers: Keypair[]): Promise<string> {
  tx.sign(signers);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false });
  const latest = await connection.getLatestBlockhash("confirmed");
  const res = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

async function sendIxs(ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[] = [], computeUnits?: number) {
  const tx = await client.buildTransaction(ixs, payer.publicKey, { computeUnits });
  return send(tx, [payer, ...extra]);
}

async function fundedUser(sol: number): Promise<Keypair> {
  const user = Keypair.generate();
  await sendIxs(
    [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: sol * LAMPORTS_PER_SOL })],
    admin,
  );
  return user;
}

const eventsNamed = <N extends LaunchpadEvent["name"]>(events: LaunchpadEvent[], name: N) =>
  events.filter((e): e is Extract<LaunchpadEvent, { name: N }> => e.name === name);

describe("launchpad e2e (local validator)", () => {
  const params: ConfigParams = {
    feeRecipient: feeRecipient.publicKey,
    ...DEFAULT_CURVE,
    ...DEFAULT_FEES,
    raydium: RAYDIUM.mainnet,
  };

  beforeAll(async () => {
    await connection.getVersion(); // fails fast when the validator is not running
    const configInfo = await connection.getAccountInfo(client.configAddress);
    const ix = configInfo
      ? await client.updateConfigInstruction(admin.publicKey, params)
      : await client.initializeInstruction(admin.publicKey, params);
    // The fee recipient must exist (rent-exempt) to receive the creation fee.
    const fund = SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: feeRecipient.publicKey,
      lamports: LAMPORTS_PER_SOL,
    });
    await sendIxs([fund, ix], admin);
  });

  it("runs the whole lifecycle: launch, trade, graduate to Raydium", async () => {
    const config = await client.fetchConfig();
    expect(config.admin.equals(admin.publicKey)).toBe(true);
    expect(config.feeRecipient.equals(feeRecipient.publicKey)).toBe(true);

    // ------------------------------------------------ launch + dev buy
    const creator = await fundedUser(10);
    const { transaction, mint, initialBuy } = await client.createTokenTransaction({
      creator: creator.publicKey,
      name: "E2E Coin",
      symbol: "E2E",
      uri: "https://example.com/e2e.json",
      initialBuyLamports: solToLamports("0.5"),
      slippageBps: 0,
    });
    const createSig = await send(transaction, [creator]);
    expect(initialBuy).not.toBeNull();

    const metadata = await client.fetchTokenMetadata(mint.publicKey);
    expect(metadata).toEqual({ name: "E2E Coin", symbol: "E2E", uri: "https://example.com/e2e.json" });
    expect(await client.fetchTokenBalance(creator.publicKey, mint.publicKey)).toBe(initialBuy!.tokenAmount);

    const createEvents = await client.fetchTransactionEvents(createSig);
    expect(eventsNamed(createEvents, "tokenCreated")[0].data.name).toBe("E2E Coin");
    expect(eventsNamed(createEvents, "trade")[0].data.tokenAmount).toBe(initialBuy!.tokenAmount);

    // ------------------------------------------------------------ buy
    const trader = await fundedUser(20);
    const { instructions: buyIxs, quote: buyQuote } = await client.buyInstructions({
      buyer: trader.publicKey,
      mint: mint.publicKey,
      solAmount: solToLamports(2),
    });
    const buySig = await sendIxs(buyIxs, trader, [], COMPUTE_UNITS.buy);
    expect(await client.fetchTokenBalance(trader.publicKey, mint.publicKey)).toBe(buyQuote.tokenAmount);
    const [trade] = eventsNamed(await client.fetchTransactionEvents(buySig), "trade");
    expect(trade.data.isBuy).toBe(true);
    expect(trade.data.solAmount).toBe(buyQuote.solAmount);
    expect(trade.data.trader.equals(trader.publicKey)).toBe(true);

    // ----------------------------------------------------------- sell
    const half = buyQuote.tokenAmount / 2n;
    const before = BigInt(await connection.getBalance(trader.publicKey));
    const { instructions: sellIxs, quote: sellQuote } = await client.sellInstructions({
      seller: trader.publicKey,
      mint: mint.publicKey,
      tokenAmount: half,
    });
    const sellSig = await sendIxs(sellIxs, trader, [], COMPUTE_UNITS.sell);
    const sellTx = await connection.getTransaction(sellSig, { maxSupportedTransactionVersion: 0 });
    const after = BigInt(await connection.getBalance(trader.publicKey));
    expect(after - before + BigInt(sellTx!.meta!.fee)).toBe(sellQuote.solOut);

    // ------------------------------------------------- creator claims fees
    const curve = await client.fetchBondingCurve(mint.publicKey);
    expect(curve!.creatorFees).toBeGreaterThan(0n);
    const metrics = LaunchpadClient.metrics(curve!, config);
    expect(metrics.progress).toBeGreaterThan(0);
    expect(metrics.marketCapSol).toBeGreaterThan(27);
    await sendIxs([await client.claimCreatorFeesInstruction({ creator: creator.publicKey, mint: mint.publicKey })], creator);
    expect((await client.fetchBondingCurve(mint.publicKey))!.creatorFees).toBe(0n);

    // ------------------------------------------ complete and graduate
    const whale = await fundedUser(200);
    const { instructions: whaleIxs, quote: whaleQuote } = await client.buyInstructions({
      buyer: whale.publicKey,
      mint: mint.publicKey,
      solAmount: solToLamports(150),
    });
    expect(whaleQuote.completesCurve).toBe(true);
    const completeSig = await sendIxs(whaleIxs, whale, [], COMPUTE_UNITS.buy);
    expect(eventsNamed(await client.fetchTransactionEvents(completeSig), "curveCompleted")).toHaveLength(1);
    expect((await client.fetchBondingCurve(mint.publicKey))!.status).toBe("complete");
    await expect(client.quoteBuy(mint.publicKey, solToLamports(1))).rejects.toThrow(/complete/);

    const cranker = await fundedUser(1);
    const migrateSig = await sendIxs(await client.migrateInstructions({ payer: cranker.publicKey, mint: mint.publicKey }), cranker);
    const [migrated] = eventsNamed(await client.fetchTransactionEvents(migrateSig), "migrated");
    const pool = findRaydiumPoolAccounts(mint.publicKey, RAYDIUM.mainnet);
    expect(migrated.data.pool.equals(pool.poolState)).toBe(true);
    expect(migrated.data.poolSolAmount).toBeGreaterThan(solToLamports(84));

    const graduated = await client.fetchBondingCurve(mint.publicKey);
    expect(graduated!.status).toBe("migrated");
    expect(graduated!.raydiumPool!.equals(pool.poolState)).toBe(true);
    const poolInfo = await connection.getAccountInfo(pool.poolState);
    expect(poolInfo!.owner.equals(RAYDIUM.mainnet.cpmmProgram)).toBe(true);
    const wsolVault = await connection.getTokenAccountBalance(pool.wsolVault);
    expect(BigInt(wsolVault.value.amount)).toBe(migrated.data.poolSolAmount);

    const migratedCurves = await client.fetchBondingCurves({ status: "migrated" });
    expect(migratedCurves.some((c) => c.mint.equals(mint.publicKey))).toBe(true);
    const created = await client.fetchBondingCurves({ creator: creator.publicKey });
    expect(created.map((c) => c.mint.toBase58())).toEqual([mint.publicKey.toBase58()]);
  });

  it("rejects trades that exceed the slippage tolerance", async () => {
    const creator = await fundedUser(5);
    const { transaction, mint } = await client.createTokenTransaction({
      creator: creator.publicKey,
      name: "Slippage",
      symbol: "SLIP",
      uri: "https://example.com/slip.json",
    });
    await send(transaction, [creator]);

    const trader = await fundedUser(5);
    const quote = await client.quoteBuy(mint.publicKey, solToLamports(1));
    const ix = await client.buyInstruction({
      buyer: trader.publicKey,
      mint: mint.publicKey,
      solAmount: solToLamports(1),
      minTokenAmount: quote.tokenAmount + 1n,
    });
    await expect(sendIxs([ix], trader)).rejects.toThrow();
  });
});

export { PublicKey };
