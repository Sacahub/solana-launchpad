/**
 * Event decoding. The program emits events with `emit_cpi!`: each event is a
 * self-invocation whose instruction data is `EVENT_IX_TAG || discriminator ||
 * borsh(event)`. Events therefore live in the transaction's inner
 * instructions and cannot be lost to log truncation.
 */
import { BorshCoder, utils, type Idl } from "@anchor-lang/core";
import type {
  ParsedTransactionWithMeta,
  PublicKey,
  VersionedTransactionResponse,
} from "@solana/web3.js";

import { LAUNCHPAD_PROGRAM_ID } from "./constants.js";
import { normalize, timestampOf } from "./convert.js";
import idl from "./idl/launchpad.json" with { type: "json" };
import type { LaunchpadEvent } from "./types.js";

/** `anchor_lang::event::EVENT_IX_TAG` (0x1d9acb512ea545e4) in little endian. */
export const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const coder = new BorshCoder(idl as Idl);

const camel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** Decodes the data of a single self-CPI event instruction, or returns null. */
export function decodeEventInstruction(data: Uint8Array): LaunchpadEvent | null {
  const buf = Buffer.from(data);
  if (buf.length < 16 || !buf.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  const decoded = coder.events.decode(buf.subarray(8).toString("base64"));
  if (!decoded) return null;
  const data_ = normalize<Record<string, unknown>>(toCamelCaseKeys(decoded.data));
  if ("timestamp" in data_) data_.timestamp = timestampOf(data_.timestamp);
  return { name: camel(decoded.name), data: data_ } as unknown as LaunchpadEvent;
}

// BorshCoder built from the raw (snake_case) IDL returns snake_case fields.
function toCamelCaseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.constructor !== Object) return value; // PublicKey, BN, ...
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = toCamelCaseKeys(v);
  }
  return out;
}

/** Extracts launchpad events, in execution order, from `getTransaction` output. */
export function parseTransactionEvents(
  tx: VersionedTransactionResponse,
  programId: PublicKey = LAUNCHPAD_PROGRAM_ID,
): LaunchpadEvent[] {
  const inner = tx.meta?.innerInstructions;
  if (!inner || inner.length === 0) return [];
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const events: LaunchpadEvent[] = [];
  for (const group of [...inner].sort((a, b) => a.index - b.index)) {
    for (const ix of group.instructions) {
      const program = keys.get(ix.programIdIndex);
      if (!program?.equals(programId)) continue;
      const event = decodeEventInstruction(utils.bytes.bs58.decode(ix.data));
      if (event) events.push(event);
    }
  }
  return events;
}

/** Same as {@link parseTransactionEvents} for `getParsedTransaction` output. */
export function parseParsedTransactionEvents(
  tx: ParsedTransactionWithMeta,
  programId: PublicKey = LAUNCHPAD_PROGRAM_ID,
): LaunchpadEvent[] {
  const inner = tx.meta?.innerInstructions;
  if (!inner) return [];
  const events: LaunchpadEvent[] = [];
  for (const group of [...inner].sort((a, b) => a.index - b.index)) {
    for (const ix of group.instructions) {
      if (!("data" in ix) || !ix.programId.equals(programId)) continue;
      const event = decodeEventInstruction(utils.bytes.bs58.decode(ix.data));
      if (event) events.push(event);
    }
  }
  return events;
}
