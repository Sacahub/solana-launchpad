/**
 * Fetches a small JSON document from a user supplied URL without exposing
 * internal services (SSRF): only public IP addresses are contacted, the check
 * happens in the socket `lookup` (no DNS rebinding window), redirects are
 * re-validated, size and time are bounded.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:xxxx:xxxx): check the IPv4 part.
    const mapped = /^::ffff:(?:0:)?(.+)$/i.exec(address);
    if (mapped) {
      const v4 = mapped[1].includes(".") ? mapped[1] : hexToIpv4(mapped[1]);
      return v4 !== null && isPublicAddress(v4);
    }
  }
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

function hexToIpv4(hex: string): string | null {
  const parts = hex.split(":");
  if (parts.length !== 2) return null;
  const [hi, lo] = parts.map((p) => Number.parseInt(p, 16));
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) {
      return callback(Object.assign(new Error(`blocked address for ${hostname}`), { code: "EBLOCKED" }), "");
    }
    const wantsAll = (options as { all?: boolean }).all;
    if (wantsAll) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Allow plain http (development only). */
  allowHttp?: boolean;
}

export async function safeFetchJson(url: string, opts: SafeFetchOptions): Promise<unknown> {
  const body = await safeFetch(url, opts, opts.maxRedirects ?? 3);
  return JSON.parse(body.toString("utf8"));
}

function safeFetch(url: string, opts: SafeFetchOptions, redirectsLeft: number): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(opts.allowHttp && parsed.protocol === "http:")) {
    return Promise.reject(new Error(`protocol not allowed: ${parsed.protocol}`));
  }
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && !isPublicAddress(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    return Promise.reject(new Error("blocked address"));
  }
  const client = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      parsed,
      { lookup: guardedLookup as never, timeout: opts.timeoutMs, headers: { accept: "application/json" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
          const next = new URL(res.headers.location, parsed).toString();
          return resolve(safeFetch(next, opts, redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`http ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), opts.timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.on("close", () => clearTimeout(deadline));
  });
}
