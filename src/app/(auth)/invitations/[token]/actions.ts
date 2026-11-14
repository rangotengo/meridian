"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { loadActor, loadAccessIdentity, requestMeta, SESSION_COOKIE } from "@/server/auth/context";
import { usesCloudflareAccess } from "@/server/auth/access";
import {
  acceptInvitationForExistingUser,
  acceptInvitationWithNewAccount,
  acceptInvitationWithAccess
} from "@/server/domain/invitations";
import {
  acceptInstanceInvitation,
  getInstanceInvitationByToken
} from "@/server/domain/instance-invitations";
import { createSession } from "@/server/security/session";
import { issueAuthToken, markEmailVerified, verificationUrl } from "@/server/security/auth-tokens";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { enqueue } from "@/server/queue";
import { isProd, requireEmailVerification } from "@/lib/env";
import { errors } from "@/lib/errors";
import { runAction, formValues, type ActionState } from "@/server/actions/runner";

const schema = z.object({
  token: z.string().min(10),
  name: z.string().optional(),
  password: z.string().optional()
});

export async function acceptInvitationAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("invitation.accept", async () => {
    if (usesCloudflareAccess()) {
      const identity = await loadAccessIdentity();
      if (!identity) throw errors.unauthorized();
      const input = schema.parse(formValues(formData));
      const actor = await loadActor();
      await acceptInvitationWithAccess(
        getDb(),
        input.token,
        identity,
        input.name ?? actor?.name ?? identity.email
      );
      redirect("/");
    }
    const input = schema.parse(formValues(formData));
    const db = getDb();
    const actor = await loadActor();

    let userId: string;
    if (actor) {
      const res = await acceptInvitationForExistingUser(db, input.token, {
        id: actor.userId,
        email: actor.email
      });
      userId = res.userId;
    } else {
      if (!input.name || !input.password) {
        throw errors.validation("Name and password are required.");
      }
      const res = await acceptInvitationWithNewAccount(db, input.token, {
        name: input.name,
        password: input.password
      });
      userId = res.userId;
    }

    const meta = await requestMeta();
    const { token } = await createSession(db, userId, meta);
    const store = await cookies();
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
    redirect("/");
  });
}

const instanceSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(120),
  password: z.string().min(10),
  familyName: z.string().min(1).max(120),
  currency: z.string().length(3).optional(),
  timezone: z.string().min(1).optional()
});

export async function acceptInstanceInvitationAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("instance_invitation.accept", async () => {
    const input = instanceSchema.parse(formValues(formData));
    const db = getDb();
    const meta = await requestMeta();
    await consumeRateLimit(db, `signup:${meta.ip ?? "unknown"}`, 10, 3600);

    // Read the invite first so the verification email below can be addressed;
    // acceptInstanceInvitation re-validates the token inside its transaction.
    const invitation = await getInstanceInvitationByToken(db, input.token);
    const result = await acceptInstanceInvitation(db, input.token, {
      name: input.name,
      password: input.password,
      familyName: input.familyName,
      currency: input.currency,
      timezone: input.timezone
    });

    // Mirror signUpAction's post-registration flow.
    if (requireEmailVerification()) {
      const token = await issueAuthToken(db, result.userId, "email_verification");
      await enqueue(db, "email", {
        to: invitation!.email,
        subject: "Verify your Meridian account",
        text: `Welcome to Meridian!\n\nConfirm your email address:\n${verificationUrl(token)}\n\nThis link expires in 48 hours.`
      });

      const { token: sessionToken } = await createSession(db, result.userId, meta);
      const store = await cookies();
      store.set(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
        path: "/",
        maxAge: 60 * 60 * 24 * 30
      });
      redirect("/verify-email");
    } else {
      await markEmailVerified(db, result.userId);

      const { token: sessionToken } = await createSession(db, result.userId, meta);
      const store = await cookies();
      store.set(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
        path: "/",
        maxAge: 60 * 60 * 24 * 30
      });
      redirect("/");
    }
  });
}
