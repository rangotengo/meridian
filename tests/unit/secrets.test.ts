import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  decryptProviderSecretWithKey,
  encryptProviderSecretWithKey,
  parseProviderSecretKey
} from "@/server/security/secrets";

describe("provider secret keys", () => {
  it("round-trips a credential with an explicit key", () => {
    const keyMaterial = randomBytes(32);
    const encrypted = encryptProviderSecretWithKey("demat-user", keyMaterial);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(decryptProviderSecretWithKey(encrypted, keyMaterial)).toBe("demat-user");
  });

  it("fails to decrypt with a different key", () => {
    const encrypted = encryptProviderSecretWithKey("demat-user", randomBytes(32));
    expect(() => decryptProviderSecretWithKey(encrypted, randomBytes(32))).toThrow(/unreadable/i);
  });

  it("parses a 32-byte base64 key and names the variable on failure", () => {
    const parsed = parseProviderSecretKey(randomBytes(32).toString("base64"), "TEST_KEY");
    expect(parsed).toHaveLength(32);
    expect(() => parseProviderSecretKey(undefined, "TEST_KEY")).toThrow(/TEST_KEY is not set/);
    expect(() =>
      parseProviderSecretKey(randomBytes(16).toString("base64"), "TEST_KEY")
    ).toThrow(/TEST_KEY must be a 32-byte base64 value/);
  });
});
