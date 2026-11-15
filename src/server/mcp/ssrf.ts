/**
 * SSRF-guarded fetching for OAuth client metadata (CIMD documents and the
 * JWKS documents they point at).
 *
 * The URLs fetched here are supplied by connecting OAuth clients, so they
 * are attacker-controlled input. `jose` signature verification proves a
 * document is *authentic for its key*; it says nothing about whether the
 * URL was safe to fetch. This module is the trust control:
 *
 *  - HTTPS only; no URL credentials; no `localhost` hostnames.
 *  - The hostname is resolved BEFORE connecting and every resolved address
 *    is checked against the RFC 6890 special-purpose ranges (private,
 *    loopback, link-local, CGNAT, documentation, multicast, reserved,
 *    IPv4-mapped IPv6 forms). Any blocked address rejects the fetch.
 *  - On Node the connection is pinned to a pre-validated address (custom
 *    DNS lookup), so the address that was checked is the address dialed.
 *  - Redirects are followed manually (max 3) and every hop re-runs the
 *    full policy, including DNS resolution for the new host.
 *  - Strict timeout (5 s) and response-size cap (32 KB); the response must
 *    be JSON by content type.
 *
 * Workers limitation (documented finding): workerd offers no DNS
 * resolution or connection pinning API, so on the Cloudflare backend the
 * resolver step is unavailable and the policy degrades to URL-level checks
 * plus per-hop re-validation over `fetch`. The Node posture is the full
 * one; the gap is recorded in docs/mcp-poc.md, not silently papered over.
 */
import { usesCloudStorage } from "../db/dialect";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 32 * 1024;

// --- IP range checks -------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this host on this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT shared address space
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay (deprecated)
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4] // 240.0.0.0/4 reserved (incl. 255.255.255.255)
];

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable → treat as blocked
  return BLOCKED_V4.some(([base, prefix]) => {
    const shift = 32 - prefix;
    return value >>> shift === base >>> shift;
  });
}

function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip.toLowerCase();
  // IPv4-mapped / IPv4-compatible tail, e.g. ::ffff:192.168.0.1
  const v4Tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const tail = v4Tail[1]!;
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536);
    const lo = v4 % 65536;
    addr = `${addr.slice(0, addr.length - tail.length)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups: string[];
  if (right === null) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  }
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

const BLOCKED_V6: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 128], // ::/128 unspecified
  [1n, 128], // ::1/128 loopback
  [0x64ff9bn << 96n, 96], // 64:ff9b::/96 NAT64 well-known prefix (embeds IPv4)
  [0x100n << 112n, 64], // 100::/64 discard-only
  [0x2001n << 112n, 32], // 2001::/32 Teredo (embeds IPv4; blocked wholesale)
  [0x20010db8n << 96n, 32], // 2001:db8::/32 documentation
  [0xfc00n << 112n, 7], // fc00::/7 unique local
  [0xfe80n << 112n, 10], // fe80::/10 link-local
  [0xff00n << 112n, 8] // ff00::/8 multicast
];

function ipv4IntToString(value: number): string {
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256
  ].join(".");
}

export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its embedded IPv4.
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIpv4(mapped[1]!);
    const value = ipv6ToBigInt(ip);
    if (value === null) return true;
    // IPv4-compatible form ::a.b.c.d (deprecated ::/96): judge the tail.
    if (value > 1n && value >> 32n === 0n) {
      return isBlockedIpv4(ipv4IntToString(Number(value)));
    }
    // 6to4 (2002::/16) embeds an IPv4 address in the next 32 bits.
    if (value >> 112n === 0x2002n) {
      const embedded = Number((value >> 80n) & 0xffffffffn);
      if (isBlockedIpv4(ipv4IntToString(embedded))) return true;
    }
    return BLOCKED_V6.some(([base, prefix]) => {
      const shift = 128n - BigInt(prefix);
      return value >> shift === base >> shift;
    });
  }
  return isBlockedIpv4(ip);
}

function isIpLiteral(hostname: string): boolean {
  return ipv4ToInt(hostname) !== null || hostname.includes(":");
}

// --- Pluggable resolution + transport (tests inject fakes) -----------------

export type MetadataHttpResponse = {
  status: number;
  contentType: string | null;
  location: string | null;
  body: string;
};

export type MetadataTransport = (
  url: URL,
  pinnedAddresses: string[] | null,
  opts: { timeoutMs: number; maxBytes: number }
) => Promise<MetadataHttpResponse>;

export type MetadataFetcherDeps = {
  /** Resolve a hostname to all of its addresses; null = resolution is not
   * available on this runtime (Workers). */
  resolveHost?: (hostname: string) => Promise<string[] | null>;
  transport?: MetadataTransport;
};

async function defaultResolveHost(hostname: string): Promise<string[] | null> {
  if (usesCloudStorage) return null;
  const dns = await import("node:dns/promises");
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

const nodeTransport: MetadataTransport = async (url, pinned, { timeoutMs, maxBytes }) => {
  const https = await import("node:https");
  return new Promise<MetadataHttpResponse>((resolvePromise, rejectPromise) => {
    const options: Record<string, unknown> = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "application/json", "user-agent": "Meridian-MCP/1.0" },
      timeout: timeoutMs
    };
    if (pinned) {
      // Pin the connection to a pre-validated address: the address that
      // was checked is the address dialed (no DNS-rebinding window).
      options.lookup = (
        _host: string,
        _opts: unknown,
        cb: (err: Error | null, address: string, family: number) => void
      ) => {
        const first = pinned[0]!;
        cb(null, first, first.includes(":") ? 6 : 4);
      };
    }
    const request = https.request(options as never, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new SsrfError(`Metadata response exceeds ${maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolvePromise({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"] ?? null,
          location: response.headers.location ?? null,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
      response.on("error", rejectPromise);
    });
    request.on("timeout", () => {
      request.destroy(new SsrfError(`Metadata fetch timed out after ${timeoutMs} ms.`));
    });
    request.on("error", rejectPromise);
    request.end();
  });
};

const fetchTransport: MetadataTransport = async (url, _pinned, { timeoutMs, maxBytes }) => {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "Meridian-MCP/1.0" }
  });
  let body = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SsrfError(`Metadata response exceeds ${maxBytes} bytes.`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    body
  };
};

function defaultTransport(): MetadataTransport {
  return usesCloudStorage ? fetchTransport : nodeTransport;
}

// --- The policy fetch -------------------------------------------------------

function validateBasicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("Metadata URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new SsrfError("Metadata URL must use https.");
  }
  if (url.username || url.password) {
    throw new SsrfError("Metadata URL must not contain credentials.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfError("Metadata URL host is not allowed.");
  }
  return url;
}

export type MetadataFetcher = (
  rawUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number }
) => Promise<unknown>;

export function createMetadataFetcher(deps: MetadataFetcherDeps = {}): MetadataFetcher {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const transport = deps.transport ?? defaultTransport();

  return async function fetchMetadataJson(rawUrl, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = validateBasicUrl(current);
      const host = url.hostname.toLowerCase();

      // Resolve first and judge EVERY address before any connection.
      let pinned: string[] | null = null;
      if (isIpLiteral(host)) {
        if (isBlockedIp(host)) {
          throw new SsrfError(`Metadata host ${host} is a blocked address.`);
        }
        pinned = [host];
      } else {
        const addresses = await resolveHost(host);
        if (addresses !== null) {
          if (addresses.length === 0) {
            throw new SsrfError(`Metadata host ${host} did not resolve.`);
          }
          for (const address of addresses) {
            if (isBlockedIp(address)) {
              throw new SsrfError(
                `Metadata host ${host} resolves to a blocked address (${address}).`
              );
            }
          }
          pinned = addresses;
        }
      }

      const response = await transport(url, pinned, { timeoutMs, maxBytes });

      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new SsrfError("Metadata redirect without a Location.");
        if (hop === maxRedirects) throw new SsrfError("Too many metadata redirects.");
        // The next loop iteration re-validates the new URL from scratch —
        // scheme, host, DNS, and address ranges — before following.
        current = new URL(response.location, url).toString();
        continue;
      }
      if (response.status !== 200) {
        throw new SsrfError(`Metadata fetch failed with HTTP ${response.status}.`);
      }
      const contentType = (response.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (contentType !== "application/json" && !contentType.endsWith("+json")) {
        throw new SsrfError(
          `Metadata response is not JSON (content-type: ${contentType || "none"}).`
        );
      }
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw new SsrfError("Metadata response is not valid JSON.");
      }
    }
    throw new SsrfError("Too many metadata redirects.");
  };
}

/** Default policy fetcher (real DNS + real transport for the runtime). */
export const fetchMetadataJson: MetadataFetcher = createMetadataFetcher();
