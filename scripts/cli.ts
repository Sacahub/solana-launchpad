/**
 * Launchpad command line tool (admin + manual testing).
 *
 *   npx tsx scripts/cli.ts <command> [options]
 *
 * Global options:
 *   --url <rpc>          RPC endpoint or moniker: localnet | devnet | mainnet (default localnet)
 *   --keypair <path>     signer (default ~/.config/solana/id.json)
 *
 * Commands:
 *   init                 create the global config (program upgrade authority only)
 *     --fee-recipient <pubkey>   (default: signer)
 *     --protocol-fee-bps <n> --creator-fee-bps <n>
 *     --creation-fee <sol> --migration-fee <sol>
 *     --raydium <mainnet|devnet> (default: from --url)
 *   update-config        same options as init, unspecified values are kept
 *   pause --create <bool> --trading <bool>
 *   config               print the config
 *   create --name <s> --symbol <s> --uri <url> [--buy <sol>]
 *   buy --mint <pubkey> --sol <amount> [--slippage-bps <n>]
 *   sell --mint <pubkey> (--tokens <amount> | --all) [--slippage-bps <n>]
 *   curve --mint <pubkey>
 *   list [--status trading|complete|migrated]
 *   claim --mint <pubkey>          claim creator fees
 *   migrate --mint <pubkey>        graduate a completed curve to Raydium
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  COMPUTE_UNITS,
  DEFAULT_CURVE,
  DEFAULT_FEES,
  LaunchpadClient,
  RAYDIUM,
  lamportsToSol,
  solToLamports,
  tokensToUnits,
  unitsToTokens,
  type ConfigAccount,
  type ConfigParams,
} from "@launchpad/sdk";
import { Connection, Keypair, PublicKey, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "localnet" },
    keypair: { type: "string" },
    "fee-recipient": { type: "string" },
    "protocol-fee-bps": { type: "string" },
    "creator-fee-bps": { type: "string" },
    "creation-fee": { type: "string" },
    "migration-fee": { type: "string" },
    raydium: { type: "string" },
    create: { type: "string" },
    trading: { type: "string" },
    name: { type: "string" },
    symbol: { type: "string" },
    uri: { type: "string" },
    buy: { type: "string" },
    mint: { type: "string" },
    sol: { type: "string" },
    tokens: { type: "string" },
    all: { type: "boolean", default: false },
    "slippage-bps": { type: "string", default: "100" },
    status: { type: "string" },
  },
});

const MONIKERS: Record<string, string> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};
const url = MONIKERS[opts.url!] ?? opts.url!;
const connection = new Connection(url, "confirmed");
const client = new LaunchpadClient(connection);
const signer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(opts.keypair ?? join(homedir(), ".config/solana/id.json"), "utf8"))),
);

const required = (name: keyof typeof opts): string => {
  const value = opts[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
};
const mintArg = () => new PublicKey(required("mint"));
const slippage = () => Number(opts["slippage-bps"]);

async function send(tx: VersionedTransaction, extraSigners: Keypair[] = []): Promise<string> {
  tx.sign([signer, ...extraSigners]);
  const signature = await connection.sendTransaction(tx);
  const latest = await connection.getLatestBlockhash("confirmed");
  const res = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (res.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

async function sendIxs(ixs: TransactionInstruction[], computeUnits?: number) {
  const signature = await send(await client.buildTransaction(ixs, signer.publicKey, { computeUnits }));
  console.log(`✔ ${signature}`);
  return signature;
}

function raydiumPreset() {
  const name = opts.raydium ?? (opts.url === "mainnet" ? "mainnet" : opts.url === "devnet" ? "devnet" : "mainnet");
  if (name !== "mainnet" && name !== "devnet") throw new Error("--raydium must be mainnet or devnet");
  return RAYDIUM[name];
}

function paramsFrom(base: Partial<ConfigParams>): ConfigParams {
  const pick = <T>(flag: string | undefined, parse: (v: string) => T, fallback: T): T =>
    flag === undefined ? fallback : parse(flag);
  return {
    feeRecipient: pick(opts["fee-recipient"], (v) => new PublicKey(v), base.feeRecipient ?? signer.publicKey),
    initialVirtualSolReserves: base.initialVirtualSolReserves ?? DEFAULT_CURVE.initialVirtualSolReserves,
    initialVirtualTokenReserves: base.initialVirtualTokenReserves ?? DEFAULT_CURVE.initialVirtualTokenReserves,
    initialRealTokenReserves: base.initialRealTokenReserves ?? DEFAULT_CURVE.initialRealTokenReserves,
    tokenTotalSupply: base.tokenTotalSupply ?? DEFAULT_CURVE.tokenTotalSupply,
    protocolFeeBps: pick(opts["protocol-fee-bps"], Number, base.protocolFeeBps ?? DEFAULT_FEES.protocolFeeBps),
    creatorFeeBps: pick(opts["creator-fee-bps"], Number, base.creatorFeeBps ?? DEFAULT_FEES.creatorFeeBps),
    creationFeeLamports: pick(opts["creation-fee"], solToLamports, base.creationFeeLamports ?? DEFAULT_FEES.creationFeeLamports),
    migrationFeeLamports: pick(opts["migration-fee"], solToLamports, base.migrationFeeLamports ?? DEFAULT_FEES.migrationFeeLamports),
    raydium: opts.raydium ? raydiumPreset() : (base.raydium ?? raydiumPreset()),
  };
}

function printConfig(c: ConfigAccount) {
  console.log({
    admin: c.admin.toBase58(),
    pendingAdmin: c.pendingAdmin?.toBase58() ?? null,
    feeRecipient: c.feeRecipient.toBase58(),
    protocolFee: `${c.protocolFeeBps / 100}%`,
    creatorFee: `${c.creatorFeeBps / 100}%`,
    creationFee: `${lamportsToSol(c.creationFeeLamports)} SOL`,
    migrationFee: `${lamportsToSol(c.migrationFeeLamports)} SOL`,
    curve: {
      virtualSol: lamportsToSol(c.initialVirtualSolReserves),
      virtualTokens: unitsToTokens(c.initialVirtualTokenReserves),
      curveTokens: unitsToTokens(c.initialRealTokenReserves),
      totalSupply: unitsToTokens(c.tokenTotalSupply),
    },
    raydium: {
      program: c.raydium.cpmmProgram.toBase58(),
      ammConfig: c.raydium.ammConfig.toBase58(),
      createPoolFee: c.raydium.createPoolFee.toBase58(),
    },
    createPaused: c.createPaused,
    tradingPaused: c.tradingPaused,
  });
}

async function main() {
  const [command] = positionals;
  switch (command) {
    case "init": {
      const params = paramsFrom({});
      await sendIxs([await client.initializeInstruction(signer.publicKey, params)]);
      printConfig(await client.fetchConfig());
      break;
    }
    case "update-config": {
      const current = await client.fetchConfig();
      const params = paramsFrom(current);
      await sendIxs([await client.updateConfigInstruction(signer.publicKey, params)]);
      printConfig(await client.fetchConfig());
      break;
    }
    case "pause": {
      const current = await client.fetchConfig();
      const flag = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === "true");
      await sendIxs([
        await client.setPausedInstruction(
          signer.publicKey,
          flag(opts.create, current.createPaused),
          flag(opts.trading, current.tradingPaused),
        ),
      ]);
      break;
    }
    case "config":
      printConfig(await client.fetchConfig());
      break;
    case "create": {
      const { transaction, mint, initialBuy } = await client.createTokenTransaction({
        creator: signer.publicKey,
        name: required("name"),
        symbol: required("symbol"),
        uri: required("uri"),
        initialBuyLamports: opts.buy ? solToLamports(opts.buy) : undefined,
        slippageBps: slippage(),
      });
      const signature = await send(transaction);
      console.log(`✔ ${signature}`);
      console.log(`mint: ${mint.publicKey.toBase58()}`);
      if (initialBuy) console.log(`dev buy: ${unitsToTokens(initialBuy.tokenAmount)} tokens`);
      break;
    }
    case "buy": {
      const { instructions, quote } = await client.buyInstructions({
        buyer: signer.publicKey,
        mint: mintArg(),
        solAmount: solToLamports(required("sol")),
        slippageBps: slippage(),
      });
      console.log(`quote: ${unitsToTokens(quote.tokenAmount)} tokens for ${lamportsToSol(quote.totalCost)} SOL`);
      await sendIxs(instructions, COMPUTE_UNITS.buy);
      break;
    }
    case "sell": {
      const mint = mintArg();
      const amount = opts.all ? await client.fetchTokenBalance(signer.publicKey, mint) : tokensToUnits(required("tokens"));
      const { instructions, quote } = await client.sellInstructions({
        seller: signer.publicKey,
        mint,
        tokenAmount: amount,
        slippageBps: slippage(),
      });
      console.log(`quote: ${lamportsToSol(quote.solOut)} SOL for ${unitsToTokens(amount)} tokens`);
      await sendIxs(instructions, COMPUTE_UNITS.sell);
      break;
    }
    case "curve": {
      const mint = mintArg();
      const [curve, config, metadata] = await Promise.all([
        client.fetchBondingCurve(mint),
        client.fetchConfig(),
        client.fetchTokenMetadata(mint),
      ]);
      if (!curve) throw new Error("no bonding curve for this mint");
      const m = LaunchpadClient.metrics(curve, config);
      console.log({
        ...metadata,
        creator: curve.creator.toBase58(),
        status: curve.status,
        progress: `${m.progress.toFixed(2)}%`,
        priceSol: m.priceSol,
        marketCapSol: m.marketCapSol.toFixed(2),
        solRaised: lamportsToSol(curve.realSolReserves),
        tokensLeft: unitsToTokens(curve.realTokenReserves),
        creatorFees: lamportsToSol(curve.creatorFees),
        raydiumPool: curve.raydiumPool?.toBase58() ?? null,
      });
      break;
    }
    case "list": {
      const status = opts.status as "trading" | "complete" | "migrated" | undefined;
      const [curves, config] = await Promise.all([client.fetchBondingCurves({ status }), client.fetchConfig()]);
      for (const c of curves.sort((a, b) => b.createdAt - a.createdAt)) {
        const m = LaunchpadClient.metrics(c, config);
        console.log(`${c.mint.toBase58()}  ${c.status.padEnd(8)}  ${m.progress.toFixed(1).padStart(5)}%  mcap ${m.marketCapSol.toFixed(1)} SOL`);
      }
      break;
    }
    case "claim":
      await sendIxs([await client.claimCreatorFeesInstruction({ creator: signer.publicKey, mint: mintArg() })]);
      break;
    case "migrate":
      await sendIxs(await client.migrateInstructions({ payer: signer.publicKey, mint: mintArg() }));
      break;
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  // Surface the program's error (e.g. "Error Code: InvalidFeeRecipient") from the simulation logs.
  const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
  const anchorError = logs.find((l) => l.includes("Error Code:"));
  console.error(`✘ ${anchorError ? anchorError.replace(/^Program log: /, "") : err instanceof Error ? err.message : err}`);
  process.exit(1);
});
