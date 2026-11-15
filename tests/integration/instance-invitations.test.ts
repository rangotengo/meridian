import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
import type { Executor } from "@/server/db/client";
import { db, makeUser, makeSuperAdmin, truncateAll, actorOf } from "../helpers";
import { signUpAction } from "@/app/(auth)/actions";
import { acceptInstanceInvitationAction } from "@/app/(auth)/invitations/[token]/actions";
import { registrationOpen } from "@/lib/env";
import { registerUserWithFamily } from "@/server/domain/users";
import {
  acceptInstanceInvitation,
  createInstanceInvitation,
  getInstanceInvitationByToken,
  listPendingInstanceInvitations,
  revokeInstanceInvitation
} from "@/server/domain/instance-invitations";
import { authTokens, families, instanceInvitations, jobs, users } from "@/server/db/schema";

// The instance-invitation action touches Next's request-scoped APIs
// (cookies/headers) and ends in redirect(). Stub both modules so the action
// can run in this harness: redirect throws the same NEXT_REDIRECT digest
// signal the real implementation throws, which runAction rethrows.
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: () => {}, get: () => undefined }),
  headers: async () => new Headers()
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT ${url}`) as Error & { digest: string };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  },
  notFound: () => {
    const err = new Error("NEXT_NOT_FOUND") as Error & { digest: string };
    err.digest = "NEXT_NOT_FOUND";
    throw err;
  },
  useRouter: () => null,
  usePathname: () => null,
  useSearchParams: () => new URLSearchParams()
}));

const originalRequireEmailVerification = process.env.REQUIRE_EMAIL_VERIFICATION;

beforeAll(async () => {
  await truncateAll();
});

afterEach(() => {
  delete process.env.REGISTRATION_OPEN;
  if (originalRequireEmailVerification !== undefined) {
    process.env.REQUIRE_EMAIL_VERIFICATION = originalRequireEmailVerification;
  } else {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  }
});

function superAdminActor(user: Awaited<ReturnType<typeof makeSuperAdmin>>) {
  return { ...actorOf(user), platformRole: "super_admin" as const };
}

function signupForm(email: string): FormData {
  const form = new FormData();
  form.set("name", "Gate Test");
  form.set("email", email);
  form.set("password", "Password123");
  form.set("familyName", "Gate Family");
  return form;
}

// Seam under test for the registration gate: signUpAction. Unlike most server
// actions it can be invoked in this harness when registration is closed,
// because the gate throws before the action touches cookies, headers, or the
// session store, and runAction converts the DomainError into an ActionState.
describe("registration gate (REGISTRATION_OPEN)", () => {
  it("defaults to open when the env var is unset", () => {
    expect(registrationOpen()).toBe(true);
  });

  it("blocks the public sign-up action when closed", async () => {
    process.env.REGISTRATION_OPEN = "false";
    expect(registrationOpen()).toBe(false);

    const state = await signUpAction(undefined, signupForm("blocked@test.local"));
    expect(state).toMatchObject({
      ok: false,
      error: "Registration is invite-only on this instance."
    });

    const [row] = await db()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "blocked@test.local"));
    expect(row).toBeUndefined();
  });

  it("does not gate the domain registration function itself", async () => {
    process.env.REGISTRATION_OPEN = "false";
    const res = await registerUserWithFamily(db(), {
      email: "domain-open@test.local",
      password: "Password123",
      name: "Domain Open",
      familyName: "Domain Family"
    });
    expect(res.userId).toBeTruthy();
    expect(res.familyId).toBeTruthy();
  });
});

describe("instance invitations", () => {
  it("rejects creation by a non-super-admin", async () => {
    const member = await makeUser();
    await expect(
      createInstanceInvitation(db(), actorOf(member, "member"), { email: "invitee@test.local" })
    ).rejects.toMatchObject({ code: "access.denied" });

    // A family admin is still not a platform admin.
    const familyAdmin = await makeUser();
    await expect(
      createInstanceInvitation(db(), actorOf(familyAdmin, "admin"), {
        email: "invitee@test.local"
      })
    ).rejects.toMatchObject({ code: "access.denied" });

    const pending = await db()
      .select({ id: instanceInvitations.id })
      .from(instanceInvitations)
      .where(eq(instanceInvitations.email, "invitee@test.local"));
    expect(pending).toHaveLength(0);
  });

  it("lets a super-admin create an invitation and records an instance-level audit event", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);

    const { token } = await createInstanceInvitation(db(), actor, {
      email: "new-household@test.local"
    });
    expect(token).toBeTruthy();

    const invitation = await getInstanceInvitationByToken(db(), token);
    expect(invitation).toMatchObject({ email: "new-household@test.local" });

    const pending = await listPendingInstanceInvitations(db(), actor);
    expect(pending.some((p) => p.email === "new-household@test.local")).toBe(true);

    const events = await db().execute<{ family_id: string | null; actor_user_id: string }>(sql`
      SELECT family_id, actor_user_id FROM audit_events
      WHERE action = 'instance_invitation.created' ORDER BY created_at DESC LIMIT 1
    `);
    expect(events.rows![0]!.family_id).toBeNull();
    expect(events.rows![0]!.actor_user_id).toBe(admin.userId);
  });

  it("rejects creation for an email that already has an active account", async () => {
    const admin = await makeSuperAdmin();
    const existing = await makeUser({ email: "taken@test.local" });
    expect(existing.email).toBe("taken@test.local");
    await expect(
      createInstanceInvitation(db(), superAdminActor(admin), { email: "taken@test.local" })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("replaces a prior pending invitation for the same email", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);

    const first = await createInstanceInvitation(db(), actor, { email: "replace-me@test.local" });
    const second = await createInstanceInvitation(db(), actor, { email: "replace-me@test.local" });

    expect(await getInstanceInvitationByToken(db(), first.token)).toBeNull();
    expect(await getInstanceInvitationByToken(db(), second.token)).not.toBeNull();
    const pending = await listPendingInstanceInvitations(db(), actor);
    expect(pending.filter((p) => p.email === "replace-me@test.local")).toHaveLength(1);
  });

  it("acceptance creates a family and an admin user, and marks the invite used", async () => {
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "founder@test.local"
    });

    const result = await acceptInstanceInvitation(db(), token, {
      name: "Founder",
      password: "Password123",
      familyName: "Founder Family",
      currency: "NPR",
      timezone: "Asia/Kathmandu"
    });

    const [user] = await db().select().from(users).where(eq(users.id, result.userId));
    expect(user).toMatchObject({
      email: "founder@test.local",
      familyId: result.familyId,
      familyRole: "admin",
      platformRole: "user"
    });
    expect(user!.emailVerifiedAt).not.toBeNull();

    const [family] = await db().select().from(families).where(eq(families.id, result.familyId));
    expect(family).toMatchObject({
      name: "Founder Family",
      currency: "NPR",
      timezone: "Asia/Kathmandu"
    });

    const [invite] = await db()
      .select()
      .from(instanceInvitations)
      .where(eq(instanceInvitations.email, "founder@test.local"));
    expect(invite!.acceptedAt).not.toBeNull();
    expect(await getInstanceInvitationByToken(db(), token)).toBeNull();

    const events = await db().execute<{ family_id: string | null }>(sql`
      SELECT family_id FROM audit_events
      WHERE action = 'instance_invitation.accepted' ORDER BY created_at DESC LIMIT 1
    `);
    expect(events.rows![0]!.family_id).toBe(result.familyId);
  });

  it("rejects a second acceptance of the same token", async () => {
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "once-only@test.local"
    });
    await acceptInstanceInvitation(db(), token, {
      name: "First",
      password: "Password123",
      familyName: "First Family"
    });
    await expect(
      acceptInstanceInvitation(db(), token, {
        name: "Second",
        password: "Password123",
        familyName: "Second Family"
      })
    ).rejects.toMatchObject({ code: "validation.failed" });
  });

  it("rejects an expired invitation", async () => {
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "expired@test.local"
    });
    await db().execute(
      sql`UPDATE instance_invitations SET expires_at = now() - interval '1 day' WHERE email = 'expired@test.local'`
    );

    expect(await getInstanceInvitationByToken(db(), token)).toBeNull();
    await expect(
      acceptInstanceInvitation(db(), token, {
        name: "Too Late",
        password: "Password123",
        familyName: "Late Family"
      })
    ).rejects.toMatchObject({ code: "validation.failed" });
  });

  it("conflicts when the invited email registered before acceptance", async () => {
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "raced@test.local"
    });
    await registerUserWithFamily(db(), {
      email: "raced@test.local",
      password: "Password123",
      name: "Racer",
      familyName: "Racer Family"
    });
    await expect(
      acceptInstanceInvitation(db(), token, {
        name: "Racer",
        password: "Password123",
        familyName: "Other Family"
      })
    ).rejects.toMatchObject({ code: "conflict" });

    // The failed acceptance must not consume the invitation.
    expect(await getInstanceInvitationByToken(db(), token)).not.toBeNull();
  });

  it("lets a super-admin revoke a pending invitation; non-admins cannot", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);
    const { token } = await createInstanceInvitation(db(), actor, {
      email: "revoke-me@test.local"
    });
    const invitation = await getInstanceInvitationByToken(db(), token);

    const member = await makeUser();
    await expect(
      revokeInstanceInvitation(db(), actorOf(member, "member"), invitation!.id)
    ).rejects.toMatchObject({ code: "access.denied" });

    await revokeInstanceInvitation(db(), actor, invitation!.id);
    expect(await getInstanceInvitationByToken(db(), token)).toBeNull();

    await expect(revokeInstanceInvitation(db(), actor, invitation!.id)).rejects.toMatchObject({
      code: "resource.not_found"
    });
  });
});

describe("instance invitations — removed accounts", () => {
  it("rejects creation for a removed account's email and creates no invitation", async () => {
    const admin = await makeSuperAdmin();
    const removed = await makeUser({ email: "removed-owner@test.local" });
    // Member removal retains the user row with removed_at set.
    await db().execute(sql`UPDATE users SET removed_at = now() WHERE id = ${removed.userId}::uuid`);

    const err = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "removed-owner@test.local"
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict" });
    // The message must be the removed-account one, not the active-account one:
    // acceptance can never succeed for this email, so creation must say why.
    expect((err as Error).message).toMatch(/removed account/);
    expect((err as Error).message).not.toBe("That person already has an account.");

    const rows = await db()
      .select({ id: instanceInvitations.id })
      .from(instanceInvitations)
      .where(eq(instanceInvitations.email, "removed-owner@test.local"));
    expect(rows).toHaveLength(0);
  });
});

describe("instance invitations — pending cap", () => {
  beforeEach(async () => {
    // The cap is instance-global: isolate it from invitations other tests
    // in this file leave behind.
    await db().delete(instanceInvitations);
  });

  async function seedLiveInvites(
    actor: ReturnType<typeof superAdminActor>,
    prefix: string,
    count: number
  ): Promise<string[]> {
    const emails: string[] = [];
    for (let i = 0; i < count; i++) {
      const email = `${prefix}-${i}@test.local`;
      await createInstanceInvitation(db(), actor, { email });
      emails.push(email);
    }
    return emails;
  }

  it("lets a super-admin reissue one of 25 live invitations", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);
    const emails = await seedLiveInvites(actor, "cap-reissue", 25);

    // Reissuing replaces the email's own pending row instead of needing a
    // 26th slot.
    const { token } = await createInstanceInvitation(db(), actor, { email: emails[0]! });
    expect(await getInstanceInvitationByToken(db(), token)).not.toBeNull();

    const pending = await listPendingInstanceInvitations(db(), actor);
    expect(pending).toHaveLength(25);
    expect(pending.filter((p) => p.email === emails[0])).toHaveLength(1);
  });

  it("rejects a genuinely new invitation when 25 live invitations are pending", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);
    await seedLiveInvites(actor, "cap-full", 25);

    await expect(
      createInstanceInvitation(db(), actor, { email: "cap-overflow@test.local" })
    ).rejects.toMatchObject({ code: "conflict" });

    const rows = await db()
      .select({ id: instanceInvitations.id })
      .from(instanceInvitations)
      .where(eq(instanceInvitations.email, "cap-overflow@test.local"));
    expect(rows).toHaveLength(0);
  });

  it("does not count expired invitations toward the cap or list them as pending", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);
    const emails = await seedLiveInvites(actor, "cap-expired", 25);
    await db().execute(sql`UPDATE instance_invitations SET expires_at = now() - interval '1 day'`);

    // All 25 slots are free again even though the expired rows still exist.
    const { token } = await createInstanceInvitation(db(), actor, {
      email: "cap-after-expiry@test.local"
    });
    expect(token).toBeTruthy();

    const pending = await listPendingInstanceInvitations(db(), actor);
    expect(pending.map((p) => p.email)).toEqual(["cap-after-expiry@test.local"]);
    expect(pending.some((p) => emails.includes(p.email))).toBe(false);
  });
});

// A second, independent connection pool so the race test's two executors are
// genuinely concurrent transactions, not two handles on one client.
function secondExecutor(): { exec: Executor; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing in test environment");
  const pool = new Pool({ connectionString: url, max: 2 });
  const exec: Executor = drizzle(pool, { schema });
  return { exec, close: () => pool.end() };
}

describe("instance invitations — atomic claim", () => {
  it("serializes acceptance racing a reissue on a second connection", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);
    const { token } = await createInstanceInvitation(db(), actor, {
      email: "race-reissue@test.local"
    });

    const second = secondExecutor();
    try {
      const [acceptance] = await Promise.allSettled([
        acceptInstanceInvitation(db(), token, {
          name: "Racer",
          password: "Password123",
          familyName: "Race Family"
        }),
        createInstanceInvitation(second.exec, actor, { email: "race-reissue@test.local" })
      ]);

      const created = await db()
        .select()
        .from(users)
        .where(eq(users.email, "race-reissue@test.local"));
      const rows = await db()
        .select()
        .from(instanceInvitations)
        .where(eq(instanceInvitations.email, "race-reissue@test.local"));

      if (acceptance.status === "fulfilled") {
        // Acceptance claimed the invitation first: exactly one household/user
        // exists for the email, and the claimed row is the accepted one (the
        // reissue's delete only targets still-pending rows).
        expect(created).toHaveLength(1);
        expect(created[0]!.familyId).toBe(acceptance.value.familyId);
        expect(rows.filter((r) => r.acceptedAt !== null)).toHaveLength(1);
      } else {
        // The reissue deleted the row first: the claim matched nothing, so
        // acceptance fails with the invalid-invitation error and no
        // household/user was committed against the dead invitation.
        expect(acceptance.reason).toMatchObject({ code: "validation.failed" });
        expect(created).toHaveLength(0);
        expect(rows.filter((r) => r.acceptedAt !== null)).toHaveLength(0);
      }
    } finally {
      await second.close();
    }
  });

  it("rolls back the claim when household creation fails, leaving the invitation usable", async () => {
    const admin = await makeSuperAdmin();
    const actor = superAdminActor(admin);
    const { token } = await createInstanceInvitation(db(), actor, {
      email: "rollback@test.local"
    });

    // Stage a post-claim failure: a user row already owns the invited email
    // (inserted directly, bypassing the domain creation checks), so
    // acceptance claims the invitation and then hits the existing-user guard
    // inside the same transaction.
    const [blockerFamily] = await db()
      .insert(families)
      .values({ name: "Blocker Family", currency: "USD", timezone: "Etc/UTC" })
      .returning({ id: families.id });
    const [blocker] = await db()
      .insert(users)
      .values({
        familyId: blockerFamily!.id,
        email: "rollback@test.local",
        passwordHash: "not-a-real-hash",
        name: "Blocker",
        familyRole: "admin",
        platformRole: "user",
        emailVerifiedAt: new Date()
      })
      .returning({ id: users.id });

    await expect(
      acceptInstanceInvitation(db(), token, {
        name: "Founder",
        password: "Password123",
        familyName: "Founder Family"
      })
    ).rejects.toMatchObject({ code: "conflict" });

    // The claim rolled back with the rest of the transaction: the invitation
    // is still pending and its token still resolves.
    const [invite] = await db()
      .select()
      .from(instanceInvitations)
      .where(eq(instanceInvitations.email, "rollback@test.local"));
    expect(invite!.acceptedAt).toBeNull();
    expect(await getInstanceInvitationByToken(db(), token)).not.toBeNull();

    // Remove the blocker: the same invitation can still be accepted.
    await db().delete(users).where(eq(users.id, blocker!.id));
    await db().delete(families).where(eq(families.id, blockerFamily!.id));

    const result = await acceptInstanceInvitation(db(), token, {
      name: "Founder",
      password: "Password123",
      familyName: "Founder Family"
    });
    const [created] = await db().select().from(users).where(eq(users.id, result.userId));
    expect(created).toMatchObject({ email: "rollback@test.local", familyId: result.familyId });
    const [used] = await db()
      .select()
      .from(instanceInvitations)
      .where(eq(instanceInvitations.email, "rollback@test.local"));
    expect(used!.acceptedAt).not.toBeNull();
  });
});

describe("instance invitations — email verification onboarding", () => {
  function acceptForm(token: string): FormData {
    const form = new FormData();
    form.set("token", token);
    form.set("name", "Action Founder");
    form.set("password", "Password123");
    form.set("familyName", "Action Family");
    return form;
  }

  it("creates an unverified user when REQUIRE_EMAIL_VERIFICATION is true", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "verify-founder@test.local"
    });

    const result = await acceptInstanceInvitation(db(), token, {
      name: "Verify Founder",
      password: "Password123",
      familyName: "Verify Family"
    });

    const [user] = await db().select().from(users).where(eq(users.id, result.userId));
    expect(user!.email).toBe("verify-founder@test.local");
    expect(user!.emailVerifiedAt).toBeNull();
  });

  it("enqueues a verification email at acceptance when verification is required", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "verify-action@test.local"
    });

    const err = await acceptInstanceInvitationAction(undefined, acceptForm(token)).catch(
      (e: unknown) => e
    );
    // The action finishes by redirecting to the verification notice.
    const digest = (err as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/verify-email");

    const [user] = await db()
      .select()
      .from(users)
      .where(eq(users.email, "verify-action@test.local"));
    expect(user).toBeTruthy();
    expect(user!.emailVerifiedAt).toBeNull();

    const emailJobs = await db().select().from(jobs).where(eq(jobs.queue, "email"));
    const payloads = emailJobs.map((j) => j.payload as { to?: string; subject?: string });
    expect(payloads).toContainEqual(
      expect.objectContaining({
        to: "verify-action@test.local",
        subject: "Verify your Meridian account"
      })
    );

    const tokens = await db().select().from(authTokens).where(eq(authTokens.userId, user!.id));
    expect(tokens.some((t) => t.purpose === "email_verification")).toBe(true);
  });

  it("verifies the user immediately and enqueues no email when verification is off", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "false";
    const admin = await makeSuperAdmin();
    const { token } = await createInstanceInvitation(db(), superAdminActor(admin), {
      email: "noverify-action@test.local"
    });

    const err = await acceptInstanceInvitationAction(undefined, acceptForm(token)).catch(
      (e: unknown) => e
    );
    const digest = (err as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).not.toContain("/verify-email");

    const [user] = await db()
      .select()
      .from(users)
      .where(eq(users.email, "noverify-action@test.local"));
    expect(user).toBeTruthy();
    expect(user!.emailVerifiedAt).not.toBeNull();

    const emailJobs = await db().select().from(jobs).where(eq(jobs.queue, "email"));
    const recipients = emailJobs.map((j) => (j.payload as { to?: string }).to);
    expect(recipients).not.toContain("noverify-action@test.local");
  });
});
