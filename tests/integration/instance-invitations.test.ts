import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, makeUser, makeSuperAdmin, truncateAll, actorOf } from "../helpers";
import { signUpAction } from "@/app/(auth)/actions";
import { registrationOpen } from "@/lib/env";
import { registerUserWithFamily } from "@/server/domain/users";
import {
  acceptInstanceInvitation,
  createInstanceInvitation,
  getInstanceInvitationByToken,
  listPendingInstanceInvitations,
  revokeInstanceInvitation
} from "@/server/domain/instance-invitations";
import { families, instanceInvitations, users } from "@/server/db/schema";

beforeAll(async () => {
  await truncateAll();
});

afterEach(() => {
  delete process.env.REGISTRATION_OPEN;
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
