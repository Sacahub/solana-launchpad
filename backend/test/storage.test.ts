import { describe, expect, it } from "vitest";

import { parseMetadataJson, resolveUri } from "../src/metadata/fetcher.js";
import { isPublicAddress, safeFetchJson } from "../src/metadata/safe-fetch.js";
import { buildMetadataJson, sniffImageType } from "../src/metadata/storage.js";

describe("image sniffing", () => {
  it("detects the supported formats from magic bytes", () => {
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("metadata json", () => {
  it("builds wallet-compatible metadata", () => {
    const json = buildMetadataJson({ name: "A", symbol: "B", website: "https://a.io" }, "https://img", "https://site");
    expect(json).toMatchObject({ name: "A", symbol: "B", image: "https://img", website: "https://a.io", createdOn: "https://site" });
    expect(json).not.toHaveProperty("twitter");
  });

  it("parses only safe http(s) links", () => {
    const parsed = parseMetadataJson({
      description: "  hello ",
      image: "ipfs://bafyimage",
      twitter: "javascript:alert(1)",
      extensions: { website: "https://site.xyz" },
    });
    expect(parsed).toEqual({
      description: "hello",
      image: "https://ipfs.io/ipfs/bafyimage",
      twitter: undefined,
      telegram: undefined,
      website: "https://site.xyz",
    });
    expect(() => parseMetadataJson("nope")).toThrow();
    expect(resolveUri("ar://abc")).toBe("https://arweave.net/abc");
  });
});

describe("SSRF protection", () => {
  it("classifies addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1",
      "100.64.0.1", "0.0.0.0", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("refuses internal targets and plain http", async () => {
    const opts = { timeoutMs: 2_000, maxBytes: 1024 };
    await expect(safeFetchJson("https://127.0.0.1/meta.json", opts)).rejects.toThrow(/blocked/);
    await expect(safeFetchJson("https://169.254.169.254/latest", opts)).rejects.toThrow(/blocked/);
    await expect(safeFetchJson("https://localhost/meta.json", opts)).rejects.toThrow(/blocked/);
    await expect(safeFetchJson("http://example.com/meta.json", opts)).rejects.toThrow(/protocol/);
    await expect(safeFetchJson("file:///etc/passwd", opts)).rejects.toThrow(/protocol/);
  });
});
