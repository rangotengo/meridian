import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { families, instanceInvitations, users } from "../db/schema";
import { assertSuperAdmin, type Actor } from "../auth/context";
import { hashPassword, hashToken, passwordPolicyError, randomToken } from "@/lib/crypto";
import { errors } from "@/lib/errors";
import { env, requireEmailVerification } from "@/lib/env";
import { isValidCurrency } from "@/lib/money";
import { recordAudit } from "../observability/audit";
import { findUserByEmail, EMAIL_PATTERN } from "./users";
import { validateTimezone } from "./families";

const INVITE_TTL_MS = 7 * 86_400_000;
const MAX_PENDING_INVITES = 25;

/**
 * Instance invitations let a platform super admin invite someone to create a
 * brand-new household on this instance. They are the counterpart to family
 * invitations (domain/invitations.ts), which add a member to an existing
 * family: an instance invitation has no family until acceptance creates one.
 */
export async function createInstanceInvitation(
  exec: Executor,
  actor: Actor,
  input: { email: string }
): Promise<{ token: string }> {
  assertSuperAdmin(actor);
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw errors.validation("Enter a valid email address.");

  const existing = await findUserByEmail(exec, email);
  if (existing && !existing.removedAt) {
    throw errors.conflict("That person already has an account.");
  }

  const [pending] = await exec
    .select({ count: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(instanceInvitations)
    .where(isNull(instanceInvitations.acceptedAt));
  if ((pending?.count ?? 0) >= MAX_PENDING_INVITES) {
    throw errors.conflict("Too many pending invitations. Revoke some first.");
  }

  await exec
    .delete(instanceInvitations)
    .where(and(isNull(instanceInvitations.acceptedAt), sql`lower(email) = ${email}`));

  const token = randomToken(32);
  const [invitation] = await exec
    .insert(instanceInvitations)
    .values({
      email,
      tokenHash: hashToken(token),
      invitedBy: actor.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS)
    })
    .returning({ id: instanceInvitations.id });

  await recordAudit(exec, {
    familyId: null,
    actorUserId: actor.userId,
    action: "instance_invitation.created",
    entityType: "instance_invitation",
    entityId: invitation!.id
  });

  return { token };
}

export function instanceInvitationUrl(token: string): string {
  return `${env.APP_URL}/invitations/${encodeURIComponent(token)}`;
}

export async function getInstanceInvitationByToken(exec: Executor, token: string) {
  if (!token) return null;
  const [row] = await exec
    .select({
      id: instanceInvitations.id,
      email: instanceInvitations.email,
      expiresAt: instanceInvitations.expiresAt,
      invitedByName: sql<string>`(SELECT name FROM users WHERE users.id = ${instanceInvitations.invitedBy})`
    })
    .from(instanceInvitations)
    .where(
      and(
        eq(instanceInvitations.tokenHash, hashToken(token)),
        isNull(instanceInvitations.acceptedAt)
      )
    )
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function acceptInstanceInvitation(
  exec: Executor,
  token: string,
  input: {
    name: string;
    password: string;
    familyName: string;
    currency?: string;
    timezone?: string;
  }
): Promise<{ userId: string; familyId: string }> {
  const { assertPasswordAuth } = await import("../auth/access");
  assertPasswordAuth();
  const name = input.name.trim();
  if (!name || name.length > 120) throw errors.validation("Your name must be 1–120 characters.");
  const policy = passwordPolicyError(input.password);
  if (policy) throw errors.validation(policy);
  const currency = (input.currency ?? "USD").toUpperCase();
  if (!isValidCurrency(currency)) throw errors.validation("Unknown currency code.");
  const timezone = validateTimezone(input.timezone ?? "Etc/UTC");

  const mustVerify = requireEmailVerification();
  const passwordHash = await hashPassword(input.password);

  return exec.transaction(async (tx) => {
    const invitation = await getInstanceInvitationByToken(tx, token);
    if (!invitation) throw errors.validation("This invitation link is invalid or has expired.");

    const existing = await findUserByEmail(tx, invitation.email);
    if (existing) throw errors.conflict("That email is already registered.");

    const [family] = await tx
      .insert(families)
      .values({
        name: input.familyName.trim() || `${name}'s family`,
        currency,
        timezone
      })
      .returning({ id: families.id });
    const familyId = family!.id;

    const [user] = await tx
      .insert(users)
      .values({
        familyId,
        email: invitation.email,
        passwordHash,
        name,
        familyRole: "admin",
        // Platform admin is never granted at signup or by invitation. Use the
        // operator flow (bin/promote-admin.ts), which requires proven inbox
        // ownership.
        platformRole: "user",
        emailVerifiedAt: mustVerify ? null : new Date()
      })
      .returning({ id: users.id });
    const userId = user!.id;

    await tx
      .update(instanceInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(instanceInvitations.id, invitation.id));

    await recordAudit(tx, {
      familyId,
      actorUserId: userId,
      action: "instance_invitation.accepted",
      entityType: "instance_invitation",
      entityId: invitation.id
    });

    return { userId, familyId };
  });
}

export async function listPendingInstanceInvitations(exec: Executor, actor: Actor) {
  assertSuperAdmin(actor);
  return exec
    .select({
      id: instanceInvitations.id,
      email: instanceInvitations.email,
      createdAt: instanceInvitations.createdAt,
      expiresAt: instanceInvitations.expiresAt
    })
    .from(instanceInvitations)
    .where(isNull(instanceInvitations.acceptedAt))
    .orderBy(desc(instanceInvitations.createdAt));
}

export async function revokeInstanceInvitation(
  exec: Executor,
  actor: Actor,
  invitationId: string
): Promise<void> {
  assertSuperAdmin(actor);
  const removed = await exec
    .delete(instanceInvitations)
    .where(eq(instanceInvitations.id, invitationId))
    .returning({ id: instanceInvitations.id });
  if (!removed.length) throw errors.notFound("Invitation");
  await recordAudit(exec, {
    familyId: null,
    actorUserId: actor.userId,
    action: "instance_invitation.revoked",
    entityType: "instance_invitation",
    entityId: invitationId
  });
}
