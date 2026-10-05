import { and, desc, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client";
import { apiKeys, users } from "../db/schema";
import type { Actor } from "../auth/context";
import { hashToken, randomToken } from "@/lib/crypto";
import { errors } from "@/lib/errors";
import { recordAudit } from "../observability/audit";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export type CreateApiKeyInput = {
  name: string;
};

export type CreatedApiKey = {
  id: string;
  rawKey: string;
  keyPrefix: string;
  name: string;
  createdAt: Date;
};

export async function createApiKey(
  exec: Executor,
  actor: Actor,
  input: CreateApiKeyInput
): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (!name || name.length > 100) {
    throw errors.validation("API key name must be between 1 and 100 characters.");
  }

  // Prefix format: mr_live_<32 random URL-safe chars>
  const token = randomToken(24);
  const rawKey = `mr_live_${token}`;
  const keyPrefix = `${rawKey.slice(0, 15)}...`;
  const keyHash = hashToken(rawKey);

  const [row] = await exec
    .insert(apiKeys)
    .values({
      familyId: actor.familyId,
      userId: actor.userId,
      name,
      keyPrefix,
      keyHash
    })
    .returning({
      id: apiKeys.id,
      createdAt: apiKeys.createdAt
    });

  if (!row) {
    throw errors.conflict("Failed to generate API key.");
  }

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "api_key.created",
    entityType: "api_key",
    entityId: row.id
  });

  return {
    id: row.id,
    rawKey,
    keyPrefix,
    name,
    createdAt: new Date(row.createdAt)
  };
}

export type ApiKeySummary = {
  id: string;
  userId: string;
  userName: string | null;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export async function listApiKeysForActor(exec: Executor, actor: Actor): Promise<ApiKeySummary[]> {
  // Members see only their own keys; family admins see every key in the family.
  const scope =
    actor.familyRole === "admin"
      ? eq(apiKeys.familyId, actor.familyId)
      : and(eq(apiKeys.familyId, actor.familyId), eq(apiKeys.userId, actor.userId));

  const rows = await exec
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      userName: users.name,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.userId))
    .where(scope)
    .orderBy(desc(apiKeys.createdAt));

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: r.userName ?? null,
    name: r.name,
    keyPrefix: r.keyPrefix,
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : null,
    revokedAt: r.revokedAt ? new Date(r.revokedAt) : null,
    createdAt: new Date(r.createdAt)
  }));
}

export async function revokeApiKey(exec: Executor, actor: Actor, keyId: string): Promise<void> {
  const [key] = await exec
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.familyId, actor.familyId)))
    .limit(1);

  if (!key) {
    throw errors.notFound("API key");
  }

  // Only the key's owner or a family admin may revoke it. Report a missing key
  // rather than a permission error so key ids of other members are not enumerable.
  if (key.userId !== actor.userId && actor.familyRole !== "admin") {
    throw errors.notFound("API key");
  }

  if (key.revokedAt) {
    return; // Already revoked
  }

  await exec
    .update(apiKeys)
    .set({
      revokedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(apiKeys.id, keyId));

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "api_key.revoked",
    entityType: "api_key",
    entityId: keyId
  });
}

export async function verifyApiKey(exec: Executor, rawKey: string): Promise<Actor | null> {
  const cleanKey = rawKey.trim();
  if (!cleanKey || !cleanKey.startsWith("mr_live_")) {
    return null;
  }

  const keyHash = hashToken(cleanKey);
  const [key] = await exec
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!key) {
    return null;
  }

  // Update lastUsedAt in the background
  await exec.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));

  // Retrieve user
  const [user] = await exec.select().from(users).where(eq(users.id, key.userId)).limit(1);

  if (!user || user.removedAt) {
    return null;
  }

  // API keys never carry the platform super-admin role: an operator who is a
  // platform admin must not be able to reach admin-only functionality by
  // presenting a personal API key.
  return {
    userId: user.id,
    sessionId: `api_key:${key.id}`,
    familyId: user.familyId,
    familyRole: user.familyRole as Actor["familyRole"],
    platformRole: "user" as const,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerifiedAt,
    authProvider: "api-key"
  };
}
