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

/** Encrypt a provider credential with an explicit rotation key. */
export function encryptProviderSecretWithKey(value: string, keyMaterial: Buffer): string {
  return encryptText(value, keyMaterial);
}

export function decryptProviderSecretWithKey(value: string, keyMaterial: Buffer): string {
  try {
    return decryptText(value, keyMaterial);
  } catch {
    throw errors.conflict("Stored MeroShare credentials are unreadable. Reconnect the account.");
  }
}

function encryptText(value: string, keyBytes: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(".");
}

function decryptText(value: string, keyBytes: Buffer): string {
  const [version, ivPart, tagPart, ciphertextPart] = value.split(".");
  if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Invalid encrypted value");
  }
  const iv = Buffer.from(ivPart, "base64");
  const tag = Buffer.from(tagPart, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error("Invalid encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64")),
    decipher.final()
  ]).toString("utf8");
}

/** Encrypt a provider credential for database storage. Never use this for access tokens. */
export function encryptProviderSecret(value: string): string {
  return encryptText(value, key());
}

export function decryptProviderSecret(value: string): string {
  try {
    return decryptText(value, key());
  } catch {
    throw errors.conflict("Stored MeroShare credentials are unreadable. Reconnect the account.");
  }
}

function parseKey(keyBase64: string | undefined, envName: string): Buffer {
  if (!keyBase64) {
    throw errors.validation(`${envName} is not set. Configure a 32-byte base64 key first.`);
  }
  const keyBytes = Buffer.from(keyBase64, "base64");
  if (keyBytes.length !== 32) {
    throw errors.validation(`${envName} must be a 32-byte base64 value.`);
  }
  return keyBytes;
}

/**
 * Encrypt text with an explicit base64 key (same `v1.iv.tag.ciphertext`
 * format as provider secrets). Used for operator backup archives, whose key
 * is configured separately from provider credentials.
 */
export function encryptWithKey(
  value: string,
  keyBase64: string | undefined,
  envName: string
): string {
  return encryptText(value, parseKey(keyBase64, envName));
}

export function decryptWithKey(
  value: string,
  keyBase64: string | undefined,
  envName: string
): string {
  const keyBytes = parseKey(keyBase64, envName);
  try {
    return decryptText(value, keyBytes);
  } catch {
    throw errors.conflict(
      "The encrypted value could not be decrypted. Check that the key matches the one used to create it."
    );
  }
}
