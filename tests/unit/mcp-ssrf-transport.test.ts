import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type https from "node:https";
import { createMetadataFetcher, nodeMetadataTransport, SsrfError } from "@/server/mcp/ssrf";

// NOTE: node:https is loaded DYNAMICALLY in beforeAll, after the proxy
// environment is cleared. Node 24's env-proxy support captures the
// proxy configuration when the https module is first loaded, so a
// static import would pin this process to the sandbox's egress proxy
// and the local test server would be unreachable.

// P1-3 / F2 regression coverage for the REAL Node metadata transport.
// Every other SSRF test injects a fake transport, which is exactly why
// the broken pinned-DNS lookup shipped: Node 24's happy-eyeballs path
// calls lookup with { all: true } and expects an array of addresses,
// and the old callback's bare-string reply threw ERR_INVALID_IP_ADDRESS
// before any HTTP response. These tests run the genuine node:https
// transport (nodeMetadataTransport — the exact function the fetcher
// uses on Node) against a local TLS server.
//
// Why not through createMetadataFetcher? The fetcher's policy layer
// (correctly) refuses to dial loopback/private addresses at all, and
// this sandbox has no locally bindable public address — so the
// transport is exercised directly, and the fetcher's budget accounting
// is covered separately below with a recording transport.

const PROXY_VARS = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY"
] as const;

const savedEnv = new Map<string, string | undefined>();
let server: https.Server;
let port = 0;

const DOC = { client_id: "https://metadata.test/client.json", client_name: "Real Transport" };

beforeAll(async () => {
  // The sandbox routes outbound HTTPS through an egress proxy
  // (NODE_USE_ENV_PROXY); the local test server must be reached
  // directly, and its self-signed fixture certificate must be accepted
  // for this test process only.
  for (const key of PROXY_VARS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  savedEnv.set("NODE_TLS_REJECT_UNAUTHORIZED", process.env.NODE_TLS_REJECT_UNAUTHORIZED);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const httpsModule = (await import("node:https")).default;
  const fixtures = path.resolve(__dirname, "../fixtures");
  server = httpsModule.createServer(
    {
      key: readFileSync(path.join(fixtures, "metadata-test-key.pem")),
      cert: readFileSync(path.join(fixtures, "metadata-test-cert.pem"))
    },
    (req, res) => {
      if (req.url === "/client.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(DOC));
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, {
          location: `https://metadata.test:${port}/client.json`
        });
        res.end();
        return;
      }
      if (req.url === "/slow") {
        // Slow-drip peer: keeps the socket BUSY (a byte every 100 ms)
        // for far longer than the deadline. A socket INACTIVITY timeout
        // alone would never fire; only the transport's absolute
        // deadline terminates this fetch promptly.
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        const drip = setInterval(() => res.write(" "), 100);
        drip.unref();
        setTimeout(() => {
          clearInterval(drip);
          res.end("}");
        }, 10_000).unref();
        return;
      }
      res.writeHead(404);
      res.end();
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Node metadata transport (real node:https, pinned DNS)", () => {
  it("fetches a document end-to-end through the pinned lookup (P1-3)", async () => {
    const response = await nodeMetadataTransport(
      new URL(`https://metadata.test:${port}/client.json`),
      ["127.0.0.1"],
      { timeoutMs: 5_000, maxBytes: 32 * 1024 }
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(DOC);
  });

  it("surfaces redirects for the fetcher loop to re-validate", async () => {
    const response = await nodeMetadataTransport(
      new URL(`https://metadata.test:${port}/redirect`),
      ["127.0.0.1"],
      { timeoutMs: 5_000, maxBytes: 32 * 1024 }
    );
    expect(response.status).toBe(302);
    expect(response.location).toBe(`https://metadata.test:${port}/client.json`);
  });

  it("enforces an absolute deadline against a slow-drip peer (F2)", async () => {
    const started = Date.now();
    await expect(
      nodeMetadataTransport(new URL(`https://metadata.test:${port}/slow`), ["127.0.0.1"], {
        timeoutMs: 250,
        maxBytes: 32 * 1024
      })
    ).rejects.toBeInstanceOf(SsrfError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("fetcher spends one shrinking budget across redirect hops (F2)", async () => {
    const seenBudgets: number[] = [];
    const fetcher = createMetadataFetcher({
      resolveHost: async () => ["93.184.216.34"],
      transport: async (_url, _pinned, opts) => {
        seenBudgets.push(opts.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: 302, contentType: null, location: "https://example.com/next", body: "" };
      }
    });
    await expect(
      fetcher("https://example.com/client.json", { timeoutMs: 350, maxRedirects: 5 })
    ).rejects.toBeInstanceOf(SsrfError);
    // Hop 2 was offered strictly less than hop 1, and the fetch died on
    // the deadline instead of following redirects indefinitely.
    expect(seenBudgets.length).toBe(2);
    expect(seenBudgets[1]!).toBeLessThan(seenBudgets[0]!);
  });
});
