import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  accessConfig,
  assertPasswordAuth,
  usesCloudflareAccess,
  verifyAccessAssertion,
  type AccessConfig
} from "@/server/auth/access";

const config: AccessConfig = {
  teamDomain: "rangotengo.cloudflareaccess.com",
  audience: "meridian-test-audience",
  allowedEmails: ["allowed@example.com"],
  allowPublicSignup: false
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" }]
  });
});
afterEach(() => vi.unstubAllEnvs());

async function token(overrides: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: `https://${config.teamDomain}`,
    aud: [config.audience],
    sub: "access-user-123",
    email: "allowed@example.com",
    type: "app",
    iat: now,
    exp: now + 3600,
    ...overrides
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(pair.privateKey);
}

describe("Cloudflare Access assertion verification", () => {
  it("allows new verified emails when public signup is explicitly enabled", async () => {
    const publicConfig = { ...config, allowedEmails: [], allowPublicSignup: true };
    expect(
      await verifyAccessAssertion(await token({ email: "new@example.com" }), publicConfig, keys)
    ).toEqual({ subject: "access-user-123", email: "new@example.com" });
    expect(
      await verifyAccessAssertion(await token({ email: "invalid" }), publicConfig, keys)
    ).toBeNull();
    expect(
      await verifyAccessAssertion(await token({ aud: "wrong-app" }), publicConfig, keys)
    ).toBeNull();
    expect(await verifyAccessAssertion(null, publicConfig, keys)).toBeNull();
  });
  it("accepts a signed application identity and normalizes its email", async () => {
    expect(
      await verifyAccessAssertion(await token({ email: "Allowed@Example.com" }), config, keys)
    ).toEqual({ subject: "access-user-123", email: "allowed@example.com" });
  });

  it.each([
    { aud: ["different-app"] },
    { iss: "https://attacker.cloudflareaccess.com" },
    { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { email: "unlisted@example.com" },
    { sub: "" },
    { sub: 123 as unknown as string },
    { type: "service" }
  ])("rejects invalid identity claims: %j", async (claims) => {
    expect(await verifyAccessAssertion(await token(claims), config, keys)).toBeNull();
  });

  it.each(["exp", "iat", "sub", "email", "aud", "iss", "type"])("requires %s", async (claim) => {
    expect(
      await verifyAccessAssertion(await token({ [claim]: undefined }), config, keys)
    ).toBeNull();
  });

  it("rejects signatures made by an untrusted key", async () => {
    const attacker = await generateKeyPair("RS256");
    const attackerKeys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(attacker.publicKey)), kid: "test" }]
    });
    expect(await verifyAccessAssertion(await token(), config, attackerKeys)).toBeNull();
  });

  it("fails closed for missing/malformed tokens and key lookup failures", async () => {
    expect(await verifyAccessAssertion(null, config, keys)).toBeNull();
    expect(await verifyAccessAssertion("not-a-jwt", config, keys)).toBeNull();
    expect(await verifyAccessAssertion("x".repeat(16385), config, keys)).toBeNull();
    expect(
      await verifyAccessAssertion(await token(), config, async () => {
        throw new Error("offline");
      })
    ).toBeNull();
  });

  it("does not accept an HMAC token", async () => {
    const forged = await new SignJWT({ email: "allowed@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: "test" })
      .sign(new Uint8Array(32));
    expect(await verifyAccessAssertion(forged, config, keys)).toBeNull();
  });
});

describe("Access configuration and password-mode boundary", () => {
  it("requires explicit public signup to omit an allowlist and rejects typos", () => {
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", config.teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", config.audience);
    vi.stubEnv("CF_ACCESS_ALLOWED_EMAILS", "");
    vi.stubEnv("CF_ACCESS_PUBLIC_SIGNUP", "false");
    expect(() => accessConfig()).toThrow();
    vi.stubEnv("CF_ACCESS_PUBLIC_SIGNUP", "true");
    expect(accessConfig().allowPublicSignup).toBe(true);
    vi.stubEnv("CF_ACCESS_PUBLIC_SIGNUP", "yes");
    expect(() => accessConfig()).toThrow();
  });
  it("requires explicit valid configuration and an email allowlist", () => {
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", config.teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", config.audience);
    vi.stubEnv("CF_ACCESS_ALLOWED_EMAILS", " Allowed@Example.com,second@example.com ");
    expect(accessConfig().allowedEmails).toEqual(["allowed@example.com", "second@example.com"]);
    vi.stubEnv("CF_ACCESS_ALLOWED_EMAILS", "");
    expect(() => accessConfig()).toThrow();
    vi.stubEnv("CF_ACCESS_ALLOWED_EMAILS", "allowed@example.com");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", "rangotengo.cloudflareaccess.com.attacker.test");
    expect(() => accessConfig()).toThrow();
  });

  it("disallows password flows in Access mode and rejects an unknown mode", () => {
    vi.stubEnv("AUTH_MODE", "cloudflare-access");
    expect(usesCloudflareAccess()).toBe(true);
    expect(() => assertPasswordAuth()).toThrow(/managed by Cloudflare Access/);
    vi.stubEnv("AUTH_MODE", "password");
    expect(() => assertPasswordAuth()).not.toThrow();
    vi.stubEnv("AUTH_MODE", "typo");
    expect(() => usesCloudflareAccess()).toThrow();
  });
});
