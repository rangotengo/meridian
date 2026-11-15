import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { errors } from "@/lib/errors";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  if (!env.MERO_SHARE_ENCRYPTION_KEY) {
    throw errors.validation(
      "MeroShare is not configured. Set MERO_SHARE_ENCRYPTION_KEY to a 32-byte base64 value first."
    );
  }
  return Buffer.from(env.MERO_SHARE_ENCRYPTION_KEY, "base64");
}

/**
 * Parse an operator-supplied encryption key (base64) for offline tooling such
 * as key rotation, where keys come from CLI environment variables rather than
 * the runtime env. Throws a validation error naming the variable at fault.
 */
export function parseProviderSecretKey(value: string | undefined, envName: string): Buffer {
  if (!value) {
    throw errors.validation(
      `${envName} is not set. Set it to a 32-byte base64 encryption key first.`
    );
  }
  const keyMaterial = Buffer.from(value, "base64");
  if (keyMaterial.length !== 32) {
    throw errors.validation(`${envName} must be a 32-byte base64 value.`);
  }
  return keyMaterial;
}

/** Encrypt a provider credential for database storage. Never use this for access tokens. */
export function encryptProviderSecretWithKey(value: string, keyMaterial: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(".");
}

export function decryptProviderSecretWithKey(value: string, keyMaterial: Buffer): string {
  const [version, ivPart, tagPart, ciphertextPart] = value.split(".");
  if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw errors.conflict("Stored MeroShare credentials are unreadable. Reconnect the account.");
  }
  try {
    const iv = Buffer.from(ivPart, "base64");
    const tag = Buffer.from(tagPart, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
      throw new Error("Invalid encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", keyMaterial, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw errors.conflict("Stored MeroShare credentials are unreadable. Reconnect the account.");
  }
}

/** Encrypt a provider credential with the instance's configured key. */
export function encryptProviderSecret(value: string): string {
  return encryptProviderSecretWithKey(value, key());
}

export function decryptProviderSecret(value: string): string {
  return decryptProviderSecretWithKey(value, key());
}
