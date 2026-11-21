"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { z } from "zod";
import { getDb, withTransaction } from "@/server/db/client";
import { assertActor, loadActor } from "@/server/auth/context";
import { runAction, formValues, type ActionState } from "@/server/actions/runner";
import * as usersSvc from "@/server/domain/users";
import * as familiesSvc from "@/server/domain/families";
import * as invitationsSvc from "@/server/domain/invitations";
import { issueAuthToken, verificationUrl } from "@/server/security/auth-tokens";
import { revokeOtherSessions } from "@/server/security/session";
import { enqueue } from "@/server/queue";
import { adminEmails, env } from "@/lib/env";
import { errors } from "@/lib/errors";
import { isThemePreference, THEME_COOKIE_MAX_AGE_SECONDS, THEME_COOKIE_NAME } from "@/lib/theme";
import { assertPasswordAuth, usesCloudflareAccess } from "@/server/auth/access";

const profileSchema = z.object({ name: z.string().min(1).max(120) });

export async function updateProfileAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("profile.update", async () => {
    const actor = await assertActor();
    const input = profileSchema.parse(formValues(formData));
    await usersSvc.updateProfile(getDb(), actor, input);
    revalidatePath("/settings");
    return undefined;
  });
}

const preferenceSchema = z.object({
  key: z.string().min(1),
  value: z.string()
});

export async function setPreferenceAction(formData: FormData): Promise<void> {
  "use server";
  const parsed = preferenceSchema.safeParse(formValues(formData));
  if (!parsed.success) return;
  const actor = await loadActor();
  if (!actor) return;
  const { key, value } = parsed.data;
  if (key === "theme" && !isThemePreference(value)) return;
  await usersSvc.setUserPreference(
    getDb(),
    actor.userId,
    key,
    key === "privacy_mode" ? value === "on" : value
  );
  if (key === "theme") {
    const store = await cookies();
    store.set(THEME_COOKIE_NAME, value, {
      path: "/",
      maxAge: THEME_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax"
    });
  }
  revalidatePath("/", "layout");
}

export async function togglePrivacyAction(): Promise<void> {
  "use server";
  const actor = await loadActor();
  if (!actor) return;
  const db = getDb();
  const current = await usersSvc.getUserPrivacyMode(db, actor.userId);
  await usersSvc.setUserPreference(db, actor.userId, "privacy_mode", !current);
  revalidatePath("/", "layout");
}

const monthlyDigestSchema = z.object({ value: z.enum(["on", "off"]).default("off") });

export async function setMonthlyDigestAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("profile.monthly_digest", async () => {
    // Verified actor only, and never a client-supplied user id: the
    // preference is always written for the signed-in user.
    const actor = await assertActor();
    if (!actor.emailVerified) {
      throw errors.forbidden("Verify your email address before opting into the monthly summary.");
    }
    const input = monthlyDigestSchema.parse(formValues(formData));
    await usersSvc.setUserPreference(getDb(), actor.userId, "monthly_digest", input.value === "on");
    revalidatePath("/settings");
    return undefined;
  });
}

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1)
});

export async function changePasswordAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("profile.change_password", async () => {
    const actor = await assertActor();
    const input = passwordChangeSchema.parse(formValues(formData));
    await withTransaction((tx) =>
      usersSvc.changePassword(tx, actor, input.currentPassword, input.newPassword)
    );
    return undefined;
  });
}

const emailChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newEmail: z.string().email()
});

export async function changeEmailAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("profile.change_email", async () => {
    const actor = await assertActor();
    const input = emailChangeSchema.parse(formValues(formData));
    const db = getDb();
    await withTransaction((tx) =>
      usersSvc.changeEmail(tx, actor, input.currentPassword, input.newEmail)
    );
    const token = await issueAuthToken(db, actor.userId, "email_verification");
    await enqueue(db, "email", {
      to: input.newEmail.toLowerCase(),
      subject: "Verify your new email address",
      text: `Confirm your new email address:\n${verificationUrl(token)}`
    });
    revalidatePath("/settings");
    return undefined;
  });
}

const orgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().min(1).optional(),
  locale: z.string().min(2).max(10).optional()
});

export async function updateFamilySettingsAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("family.update", async () => {
    const actor = await assertActor();
    const parsed = orgSchema.safeParse(formValues(formData));
    if (!parsed.success)
      throw (await import("@/lib/errors")).errors.validation("Check organization fields.");
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (typeof v === "string") patch[k] = v;
    }
    await withTransaction((tx) => familiesSvc.updateFamilySettings(tx, actor, patch));
    revalidatePath("/settings");
    revalidatePath("/", "layout");
    return undefined;
  });
}

const deleteFamilySchema = z.object({ confirmName: z.string().min(1) });

export async function deleteFamilyAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("family.delete", async () => {
    const actor = await assertActor();
    const input = deleteFamilySchema.parse(formValues(formData));
    await withTransaction((tx) => familiesSvc.deleteFamily(tx, actor, input.confirmName));
    if (!usesCloudflareAccess()) {
      await revokeOtherSessions(getDb(), actor.userId, actor.sessionId);
    }
    const store = await import("next/headers").then((m) => m.cookies());
    store.delete("meridian_session");
    redirect("/sign-in?deleted=1");
  });
}

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"])
});

export async function createInvitationAction(
  _prev: ActionState<{ inviteUrl?: string; emailQueued: boolean }> | undefined,
  formData: FormData
): Promise<ActionState<{ inviteUrl?: string; emailQueued: boolean }>> {
  return runAction("invitation.create", async () => {
    const actor = await assertActor();
    const input = inviteSchema.parse(formValues(formData));
    const targetEmail = input.email.toLowerCase().trim();
    if (adminEmails().includes(targetEmail)) {
      throw errors.forbidden(
        "Platform administrator addresses cannot be invited to join a family."
      );
    }
    let url = "";
    await withTransaction(async (tx) => {
      const { token } = await invitationsSvc.createInvitation(tx, actor, input);
      url = invitationsSvc.invitationUrl(token);
      if (env.MAIL_TRANSPORT !== "manual")
        await enqueue(tx, "email", {
          to: targetEmail,
          subject: "You're invited to join a family on Meridian",
          text: `Accept your invitation:\n${url}\n\nThis link expires in 7 days.`
        });
    });
    revalidatePath("/settings/members");
    const exposeUrl = env.MAIL_TRANSPORT === "console" || env.MAIL_TRANSPORT === "manual";
    return { inviteUrl: exposeUrl ? url : undefined, emailQueued: env.MAIL_TRANSPORT !== "manual" };
  });
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("invitationId") ?? "");
  await runAction("invitation.revoke", async () => {
    const actor = await assertActor();
    await withTransaction((tx) => invitationsSvc.revokeInvitation(tx, actor, id));
    revalidatePath("/settings/members");
  });
}

const memberSchema = z.object({
  userId: z.string().uuid(),
  op: z.enum(["promote", "demote", "remove"])
});

export async function manageMemberAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("member.manage", async () => {
    const parsed = memberSchema.safeParse(formValues(formData));
    if (!parsed.success) {
      throw (await import("@/lib/errors")).errors.validation("Invalid member operation.");
    }
    const actor = await assertActor();
    const db = getDb();
    if (parsed.data.op === "remove") {
      await usersSvc.removeMember(db, actor, parsed.data.userId);
    } else {
      await usersSvc.setMemberRole(
        db,
        actor,
        parsed.data.userId,
        parsed.data.op === "promote" ? "admin" : "member"
      );
    }
    revalidatePath("/settings/members");
    return undefined;
  });
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  "use server";
  const sessionId = String(formData.get("sessionId") ?? "");
  await runAction("session.revoke", async () => {
    assertPasswordAuth();
    const actor = await assertActor();
    await usersSvc.revokeSessionOwned(getDb(), actor, sessionId);
    revalidatePath("/settings/security");
  });
}

export async function revokeOtherSessionsAction(): Promise<void> {
  "use server";
  await runAction("session.revoke_others", async () => {
    assertPasswordAuth();
    const actor = await assertActor();
    await revokeOtherSessions(getDb(), actor.userId, actor.sessionId);
    revalidatePath("/settings/security");
  });
}
