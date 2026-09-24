/**
 * Storage of token images and metadata JSON files.
 *
 * - `local`: files are written to disk and served by this API under /files.
 *   Perfect for development; in production the URIs must stay reachable
 *   forever, so prefer IPFS/Arweave.
 * - `pinata`: files are pinned on IPFS through Pinata and referenced through
 *   an HTTP gateway (wallets and explorers resolve https URIs best).
 *
 * Files are content-addressed, uploading the same bytes twice is harmless.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StoredFile {
  /** Public URL of the file. */
  url: string;
}

export interface Storage {
  put(bytes: Uint8Array, contentType: string, name: string): Promise<StoredFile>;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/json": "json",
};

export class LocalStorage implements Storage {
  constructor(
    private readonly dir: string,
    private readonly publicBaseUrl: string,
  ) {}

  async put(bytes: Uint8Array, contentType: string): Promise<StoredFile> {
    const ext = EXTENSIONS[contentType];
    if (!ext) throw new Error(`unsupported content type ${contentType}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const file = `${hash}.${ext}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, file), bytes);
    return { url: `${this.publicBaseUrl}/files/${file}` };
  }
}

export class PinataStorage implements Storage {
  constructor(
    private readonly jwt: string,
    private readonly gateway: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(bytes: Uint8Array, contentType: string, name: string): Promise<StoredFile> {
    const form = new FormData();
    form.append("network", "public");
    form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), name);
    const res = await this.fetchImpl("https://uploads.pinata.cloud/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    });
    if (!res.ok) throw new Error(`pinata upload failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data?: { cid?: string } };
    const cid = body.data?.cid;
    if (!cid) throw new Error("pinata upload returned no cid");
    return { url: `${this.gateway}/ipfs/${cid}` };
  }
}

/** Detects the image type from its magic bytes (never trust the declared type). */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  return null;
}

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Off-chain metadata JSON (Metaplex fungible token standard, understood by
 * wallets and explorers) referenced by the on-chain `uri`.
 */
export function buildMetadataJson(input: TokenMetadataInput, imageUrl: string, createdOn: string) {
  const json: Record<string, unknown> = {
    name: input.name,
    symbol: input.symbol,
    description: input.description ?? "",
    image: imageUrl,
    showName: true,
    createdOn,
  };
  if (input.twitter) json.twitter = input.twitter;
  if (input.telegram) json.telegram = input.telegram;
  if (input.website) json.website = input.website;
  json.properties = { files: [{ uri: imageUrl, type: "image" }], category: "image" };
  return json;
}
