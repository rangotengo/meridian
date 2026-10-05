import { mergeJson } from "@/server/db/dialect";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import {
  accountShares,
  accounts,
  apiKeys,
  authTokens,
  families,
  sessions,
  users
} from "../db/schema";
import type { Actor } from "../auth/context";
import { hashPassword, passwordPolicyError, verifyPassword } from "@/lib/crypto";
import { errors } from "@/lib/errors";
import { requireEmailVerification } from "@/lib/env";
import { isValidCurrency } from "@/lib/money";
import { validateTimezone } from "./families";
import { recordAudit } from "../observability/audit";
import { assertPasswordAuth } from "../auth/access";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(exec: Executor, email: string) {
  const [row] = await exec
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  return row ?? null;
}

export type RegistrationResult = { userId: string; familyId: string };

export async function registerUserWithFamily(
  exec: Executor,
  input: {
    email: string;
    password: string;
    name: string;
    familyName: string;
    currency?: string;
    timezone?: string;
  }
): Promise<RegistrationResult> {
  assertPasswordAuth();
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) throw errors.validation("Enter a valid email address.");
  const name = input.name.trim();
  if (!name || name.length > 120) throw errors.validation("Your name must be 1–120 characters.");
  const policy = passwordPolicyError(input.password);
  if (policy) throw errors.validation(policy);

  const existing = await findUserByEmail(exec, email);
  if (existing) throw errors.conflict("That email is already registered.");
  const currency = (input.currency ?? "USD").toUpperCase();
  if (!isValidCurrency(currency)) throw errors.validation("Unknown currency code.");
  const timezone = validateTimezone(input.timezone ?? "Etc/UTC");

  const mustVerify = requireEmailVerification();

  const result = await exec.transaction(async (tx) => {
    const [family] = await tx
      .insert(families)
      .values({
        name: input.familyName.trim() || `${name}'s family`,
        currency,
        timezone
      })
      .returning({ id: families.id });
    const fid = family!.id;
    const [user] = await tx
      .insert(users)
      .values({
        familyId: fid,
        email,
        passwordHash: await hashPassword(input.password),
        name,
        familyRole: "admin",
        // Platform admin is never granted at signup. Use the operator flow
        // (bin/promote-admin.ts), which requires proven inbox ownership.
        platformRole: "user",
        emailVerifiedAt: mustVerify ? null : new Date()
      })
      .returning({ id: users.id });
    return { userId: user!.id, familyId: fid };
  });

  await recordAudit(exec, {
    familyId: result.familyId,
    actorUserId: result.userId,
    action: "user.registered",
    entityType: "user",
    entityId: result.userId
  });
  return result;
}

export type PlatformAdminOutcome =
  | { status: "promoted" }
  | { status: "already_admin" }
  | { status: "verification_required"; verificationToken: string };

/**
 * Operator-only platform admin grant (S13). Never reachable from public flows.
 * Requires proven inbox ownership: a previously consumed email-verification or
 * password-reset token. When ownership is unproven, a fresh verification token
 * is issued and the caller must deliver it to the account owner.
 */
export async function grantPlatformAdmin(
  exec: Executor,
  email: string
): Promise<PlatformAdminOutcome> {
  const user = await findUserByEmail(exec, email);
  if (!user) throw errors.notFound("User");
  if (user.removedAt) {
    throw errors.conflict("This account has been removed from its family and cannot be promoted.");
  }
  if (user.platformRole === "super_admin") return { status: "already_admin" };

  const [consumed] = await exec
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.userId, user.id),
        inArray(authTokens.purpose, ["email_verification", "password_reset"]),
        isNotNull(authTokens.usedAt)
      )
    )
    .limit(1);

  if (!consumed) {
    const { issueAuthToken } = await import("../security/auth-tokens");
    const verificationToken = await issueAuthToken(exec, user.id, "email_verification");
    return { status: "verification_required", verificationToken };
  }

  await exec
    .update(users)
    .set({ platformRole: "super_admin", updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await recordAudit(exec, {
    familyId: user.familyId,
    actorUserId: user.id,
    action: "user.platform_admin_granted",
    entityType: "user",
    entityId: user.id
  });
  return { status: "promoted" };
}

export async function revokePlatformAdmin(exec: Executor, email: string): Promise<boolean> {
  const user = await findUserByEmail(exec, email);
  if (!user) throw errors.notFound("User");
  if (user.platformRole !== "super_admin") return false;
  await exec
    .update(users)
    .set({ platformRole: "user", updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await recordAudit(exec, {
    familyId: user.familyId,
    actorUserId: user.id,
    action: "user.platform_admin_revoked",
    entityType: "user",
    entityId: user.id
  });
  return true;
}

export async function authenticate(
  exec: Executor,
  input: { email: string; password: string },
  meta: { ip?: string | null }
): Promise<{ token: string }> {
  assertPasswordAuth();
  const { createSession } = await import("../security/session");
  const { consumeRateLimit } = await import("../security/rate-limit");
  const ipKey = meta.ip ?? "unknown";
  await consumeRateLimit(exec, `login:${ipKey}:${normalizeEmail(input.email)}`, 5, 900);

  const user = await findUserByEmail(exec, input.email);
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
    throw errors.unauthorized();
  }
  if (user.removedAt) {
    throw errors.forbidden(
      "This account has been removed from its family. To rejoin, ask a family admin to send a new invitation."
    );
  }

  const { token } = await createSession(exec, user.id, meta);
  await recordAudit(exec, {
    familyId: user.familyId,
    actorUserId: user.id,
    action: "user.signed_in",
    entityType: "session"
  });
  return { token };
}

export async function changePassword(
  exec: Executor,
  actor: Actor,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  assertPasswordAuth();
  const [user] = await exec.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user) throw errors.unauthorized();
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw errors.validation("Current password is incorrect.");
  }
  const policy = passwordPolicyError(newPassword);
  if (policy) throw errors.validation(policy);

  await exec
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, actor.userId));

  const { revokeOtherSessions } = await import("../security/session");
  await revokeOtherSessions(exec, actor.userId, actor.sessionId);
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "user.password_changed",
    entityType: "user",
    entityId: actor.userId
  });
}

export async function requestPasswordReset(exec: Executor, email: string): Promise<string | null> {
  assertPasswordAuth();
  const user = await findUserByEmail(exec, email);
  if (!user) return null;
  const { issueAuthToken } = await import("../security/auth-tokens");
  return issueAuthToken(exec, user.id, "password_reset");
}

export async function performPasswordReset(
  exec: Executor,
  token: string,
  newPassword: string
): Promise<void> {
  assertPasswordAuth();
  const policy = passwordPolicyError(newPassword);
  if (policy) throw errors.validation(policy);
  const { consumeAuthToken, markEmailVerified } = await import("../security/auth-tokens");
  const { revokeAllSessions } = await import("../security/session");
  const passwordHash = await hashPassword(newPassword);

  await exec.transaction(async (tx) => {
    const consumed = await consumeAuthToken(tx, token, "password_reset");
    if (!consumed) throw errors.validation("This reset link is invalid or has expired.");

    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, consumed.userId));
    await markEmailVerified(tx, consumed.userId);
    await revokeAllSessions(tx, consumed.userId);

    await recordAudit(tx, {
      actorUserId: consumed.userId,
      action: "user.password_reset",
      entityType: "user",
      entityId: consumed.userId
    });
  });
}

export async function listSessionsForActor(exec: Executor, actor: Actor) {
  return exec
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      ip: sessions.ip,
      userAgent: sessions.userAgent
    })
    .from(sessions)
    .where(eq(sessions.userId, actor.userId))
    .orderBy(desc(sessions.lastUsedAt));
}

export async function revokeSessionOwned(
  exec: Executor,
  actor: Actor,
  sessionId: string
): Promise<boolean> {
  const removed = await exec
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, actor.userId)))
    .returning({ id: sessions.id });
  return removed.length > 0;
}

export async function updateProfile(
  exec: Executor,
  actor: Actor,
  patch: { name?: string }
): Promise<void> {
  const updates: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 120) throw errors.validation("Name must be 1–120 characters.");
    updates.name = name;
  }
  await exec.update(users).set(updates).where(eq(users.id, actor.userId));
}

export async function changeEmail(
  exec: Executor,
  actor: Actor,
  currentPassword: string,
  newEmailRaw: string
): Promise<void> {
  assertPasswordAuth();
  const newEmail = normalizeEmail(newEmailRaw);
  if (!EMAIL_PATTERN.test(newEmail)) throw errors.validation("Enter a valid email address.");
  const [user] = await exec.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user) throw errors.unauthorized();
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw errors.validation("Current password is incorrect.");
  }
  const clash = await findUserByEmail(exec, newEmail);
  if (clash && clash.id !== actor.userId) {
    throw errors.conflict("That email is already registered.");
  }

  await exec.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ email: newEmail, emailVerifiedAt: null, updatedAt: new Date() })
      .where(eq(users.id, actor.userId));

    const { invalidateUserTokens } = await import("../security/auth-tokens");
    await invalidateUserTokens(tx, actor.userId);

    const { revokeAllSessions } = await import("../security/session");
    await revokeAllSessions(tx, actor.userId);

    await recordAudit(tx, {
      familyId: actor.familyId,
      actorUserId: actor.userId,
      action: "user.email_changed",
      entityType: "user",
      entityId: actor.userId
    });
  });
}

export async function setUserPreference(
  exec: Executor,
  userId: string,
  key: string,
  value: unknown
): Promise<void> {
  await exec.execute(sql`
    UPDATE users SET preferences = ${mergeJson(sql`preferences`, { [key]: value })}
    WHERE id = ${userId}
  `);
}

export async function getUserPrivacyMode(exec: Executor, userId: string): Promise<boolean> {
  const res = await exec.execute<{ privacy_mode: boolean | null }>(
    sql`SELECT CAST((preferences->>'privacy_mode') AS BOOLEAN) AS privacy_mode FROM users WHERE id = ${userId}`
  );
  return Boolean((res.rows ?? [])[0]?.privacy_mode);
}

export async function getPreference<T>(
  prefs: Record<string, unknown>,
  key: string,
  fallback: T
): Promise<T> {
  const v = prefs?.[key];
  return (v === undefined || v === null ? fallback : v) as T;
}

export async function listFamilyMembers(exec: Executor, familyId: string) {
  return exec
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.familyRole,
      platformRole: users.platformRole,
      verified: sql<boolean>`email_verified_at IS NOT NULL`,
      joinedAt: users.createdAt
    })
    .from(users)
    .where(and(eq(users.familyId, familyId), isNull(users.removedAt)))
    .orderBy(users.createdAt);
}

export async function removeMember(
  exec: Executor,
  actor: Actor,
  targetUserId: string
): Promise<void> {
  if (actor.familyRole !== "admin")
    throw errors.forbidden("Only family admins can remove members.");
  if (targetUserId === actor.userId)
    throw errors.validation("You cannot remove yourself. Delete the family instead.");
  const [target] = await exec.select().from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!target || target.familyId !== actor.familyId) throw errors.notFound("Member");
  if (target.removedAt) throw errors.conflict("This member has already been removed.");
  if (target.platformRole === "super_admin") {
    throw errors.forbidden(
      "This member is a platform administrator. Ask the operator to demote them first."
    );
  }
  if (target.familyRole === "admin") {
    const admins = await countFamilyAdmins(exec, actor.familyId);
    if (admins <= 1) throw errors.conflict("Promote another admin before removing the last admin.");
  }

  await exec.transaction(async (tx) => {
    // Deactivate instead of delete (S14): the member's accounts, ledger
    // entries, balances, and audit history stay preserved under a
    // deactivated owner instead of cascading away.
    await tx
      .update(users)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, targetUserId));

    // Revoke every access path for the removed member: their sessions,
    // tokens, and API keys, shares granted to them, and shares on the
    // accounts they own (those accounts are archived under the deactivated
    // owner).
    await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
    await tx.delete(authTokens).where(eq(authTokens.userId, targetUserId));
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(apiKeys.userId, targetUserId), isNull(apiKeys.revokedAt)));
    await tx.delete(accountShares).where(eq(accountShares.userId, targetUserId));
    await tx
      .delete(accountShares)
      .where(
        inArray(
          accountShares.accountId,
          tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.ownerId, targetUserId))
        )
      );
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "member.removed",
    entityType: "user",
    entityId: targetUserId
  });
}

export async function setMemberRole(
  exec: Executor,
  actor: Actor,
  targetUserId: string,
  role: "admin" | "member"
): Promise<void> {
  if (actor.familyRole !== "admin") throw errors.forbidden("Only family admins can change roles.");
  const [target] = await exec.select().from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!target || target.familyId !== actor.familyId || target.removedAt)
    throw errors.notFound("Member");
  if (target.familyRole === "admin" && role === "member") {
    const admins = await countFamilyAdmins(exec, actor.familyId);
    if (admins <= 1) throw errors.conflict("Promote another admin before demoting the last admin.");
  }
  await exec
    .update(users)
    .set({ familyRole: role, updatedAt: new Date() })
    .where(eq(users.id, targetUserId));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "member.role_changed",
    entityType: "user",
    entityId: targetUserId,
    metadata: { role }
  });
}

async function countFamilyAdmins(exec: Executor, familyId: string): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(users)
    .where(
      and(eq(users.familyId, familyId), eq(users.familyRole, "admin"), isNull(users.removedAt))
    );
  return row?.count ?? 0;
}
