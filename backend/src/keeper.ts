/**
 * Keeper bot: graduates completed curves to Raydium as soon as they complete
 * and optionally sweeps protocol fees. Migration is permissionless and the
 * keeper only pays transaction fees (temporary rent is refunded in the same
 * instruction), so a wallet with ~0.05 SOL is enough.
 *
 * State is read on-chain (getProgramAccounts), not from the indexer, so the
 * keeper keeps working even if the database lags behind.
 */
import { COMPUTE_UNITS, LaunchpadClient, type BondingCurveAccount } from "@launchpad/sdk";
import type { Keypair, TransactionInstruction } from "@solana/web3.js";

export interface KeeperOptions {
  intervalMs: number;
  collectFeesMinLamports: bigint;
  priorityFeeMicroLamports: number;
  log?: (msg: string, extra?: unknown) => void;
}

export class Keeper {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Mints whose migration failed recently: retried after a cool-down. */
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly client: LaunchpadClient,
    private readonly wallet: Keypair,
    private readonly opts: KeeperOptions,
  ) {}

  private log(msg: string, extra?: unknown) {
    (this.opts.log ?? ((m, e) => console.log(`[keeper] ${m}`, e ?? "")))(msg, extra);
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.opts.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<{ migrated: string[]; collected: string[] }> {
    const result = { migrated: [] as string[], collected: [] as string[] };
    if (this.busy) return result;
    this.busy = true;
    try {
      const config = await this.client.fetchConfig();
      for (const curve of await this.client.fetchBondingCurves({ status: "complete" })) {
        const mint = curve.mint.toBase58();
        if ((this.failures.get(mint) ?? 0) > Date.now()) continue;
        try {
          const ixs = await this.client.migrateInstructions({ payer: this.wallet.publicKey, mint: curve.mint, config });
          const signature = await this.send(ixs);
          this.failures.delete(mint);
          result.migrated.push(mint);
          this.log(`migrated ${mint}`, signature);
        } catch (err) {
          this.failures.set(mint, Date.now() + 60_000);
          this.log(`migration of ${mint} failed`, err instanceof Error ? err.message : err);
        }
      }

      if (this.opts.collectFeesMinLamports > 0n) {
        const curves = await this.client.fetchBondingCurves({ status: "trading" });
        const due = curves.filter((c: BondingCurveAccount) => c.protocolFees >= this.opts.collectFeesMinLamports);
        for (const curve of due) {
          try {
            const ix = await this.client.collectProtocolFeesInstruction({
              mint: curve.mint,
              feeRecipient: config.feeRecipient,
            });
            await this.send([ix], COMPUTE_UNITS.claim);
            result.collected.push(curve.mint.toBase58());
          } catch (err) {
            this.log(`fee collection for ${curve.mint.toBase58()} failed`, err instanceof Error ? err.message : err);
          }
        }
      }
    } catch (err) {
      this.log("tick failed", err instanceof Error ? err.message : err);
    } finally {
      this.busy = false;
    }
    return result;
  }

  private async send(instructions: TransactionInstruction[], computeUnits?: number): Promise<string> {
    const connection = this.client.connection;
    const tx = await this.client.buildTransaction(instructions, this.wallet.publicKey, {
      computeUnits,
      priorityFeeMicroLamports: this.opts.priorityFeeMicroLamports || undefined,
    });
    tx.sign([this.wallet]);
    const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
    const latest = await connection.getLatestBlockhash("confirmed");
    const res = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (res.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
    return signature;
  }
}
