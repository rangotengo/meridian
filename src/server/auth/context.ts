import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { families, users } from "../db/schema";
import { findLiveSession, touchSession } from "../security/session";
import { errors } from "@/lib/errors";
import { requireEmailVerification } from "@/lib/env";
import { accessConfig, usesCloudflareAccess, verifyAccessAssertion } from "./access";
import { findAccessUser } from "../domain/access-users";

export const SESSION_COOKIE = "meridian_session";

export type Actor = {
  userId: string;
  sessionId: string;
  familyId: string;
  familyRole: "admin" | "member";
  platformRole: "user" | "super_admin";
  email: string;
  name: string;
  emailVerified: boolean;
  authProvider?: "password" | "cloudflare-access" | "api-key" | "oauth";
};

export type Family = typeof families.$inferSelect;

export function actorFromRow(user: typeof users.$inferSelect, sessionId: string): Actor {
  return {
    userId: user.id,
    sessionId,
    familyId: user.familyId,
    familyRole: user.familyRole as Actor["familyRole"],
    platformRole: user.platformRole as Actor["platformRole"],
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerifiedAt
  };
}

export async function loadActor(): Promise<Actor | null> {
  if (usesCloudflareAccess()) {
    const identity = await loadAccessIdentity();
    if (!identity) return null;
    const user = await findAccessUser(getDb(), identity);
    if (!user) return null;
    // Access owns session lifetime and revocation; no Meridian session cookie is accepted.
    return { ...actorFromRow(user, ""), emailVerified: true, authProvider: "cloudflare-access" };
  }
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const session = await findLiveSession(db, token);
  if (!session) return null;
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || user.removedAt) return null;
  await touchSession(db, session);
  return actorFromRow(user, session.id);
}

export async function loadAccessIdentity() {
  if (!usesCloudflareAccess()) return null;
  const assertion = (await headers()).get("cf-access-jwt-assertion");
  return verifyAccessAssertion(assertion, accessConfig());
}

export async function requireActor(): Promise<Actor> {
  const actor = await loadActor();
  if (!actor) redirect("/sign-in");
  return actor;
}

export async function requireVerifiedActor(): Promise<Actor> {
  const actor = await requireActor();
  if (requireEmailVerification() && !actor.emailVerified) redirect("/verify-email");
  return actor;
}

export async function requireSuperAdmin(): Promise<Actor> {
  const actor = await requireVerifiedActor();
  if (actor.platformRole !== "super_admin") redirect("/");
  return actor;
}

/**
 * Non-redirecting equivalent of requireSuperAdmin for domain code and tests:
 * throws a forbidden DomainError instead of redirecting, so callers that
 * already hold an Actor (server actions after requireSuperAdmin, domain
 * services) can enforce the platform-admin boundary without Next.js.
 */
export function assertSuperAdmin(actor: Actor): void {
  if (actor.platformRole !== "super_admin") {
    throw errors.forbidden("Only a platform admin can perform that action.");
  }
}

export function assertActorVerified(actor: Actor): void {
  if (requireEmailVerification() && !actor.emailVerified) {
    throw errors.forbidden("Email verification is required.");
  }
}

export async function assertActor(opts: { allowUnverified?: boolean } = {}): Promise<Actor> {
  const actor = await loadActor();
  if (!actor) throw errors.unauthorized();
  if (!opts.allowUnverified) {
    assertActorVerified(actor);
  }
  return actor;
}

export async function assertVerifiedActor(): Promise<Actor> {
  return assertActor({ allowUnverified: false });
}

export async function currentFamily(actor: Actor): Promise<Family> {
  const [family] = await getDb()
    .select()
    .from(families)
    .where(eq(families.id, actor.familyId))
    .limit(1);
  if (!family) throw errors.notFound("Family");
  return family;
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const trustProxy =
    process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY_HEADERS === "true";
  let ip: string | null = null;
  if (trustProxy) {
    const forwarded = h.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      ip = (parts.length > 0 ? parts[0] : null) ?? null;
    } else {
      ip = h.get("x-real-ip") ?? null;
    }
  }
  return {
    ip,
    userAgent: h.get("user-agent") ? h.get("user-agent")!.slice(0, 500) : null
  };
}
