"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateNextPath } from "@/lib/next-path";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { loadActor, requestMeta, SESSION_COOKIE } from "@/server/auth/context";
import {
  authenticate,
  performPasswordReset,
  registerUserWithFamily,
  requestPasswordReset
} from "@/server/domain/users";
import {
  issueAuthToken,
  verificationUrl,
  consumeAuthToken,
  markEmailVerified
} from "@/server/security/auth-tokens";
import { signOutAction as signOutSession } from "@/server/actions/session-actions";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { enqueue } from "@/server/queue";
import { env, isProd, registrationOpen, requireEmailVerification } from "@/lib/env";
import { errors } from "@/lib/errors";
import { runAction, type ActionState } from "@/server/actions/runner";

const signInSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1)
});

export async function signInAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("auth.sign_in", async () => {
    const input = signInSchema.parse(Object.fromEntries(formData));
    const next = validateNextPath(formData.get("next"));
    const db = getDb();
    const meta = await requestMeta();
    const { token } = await authenticate(db, input, meta);
    const store = await cookies();
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
    redirect(next);
  });
}

const signUpSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(1),
  familyName: z.string().min(1).max(120),
  currency: z.string().length(3).optional(),
  timezone: z.string().min(1).optional()
});

export async function signUpAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("auth.sign_up", async () => {
    // Invite-only instances close public registration here, at the action
    // boundary; invited users arrive via /invitations/<token> instead. The
    // domain registration function itself is deliberately left unchanged.
    if (!registrationOpen()) {
      throw errors.forbidden("Registration is invite-only on this instance.");
    }
    const input = signUpSchema.parse(Object.fromEntries(formData));
    const db = getDb();
    const meta = await requestMeta();
    await consumeRateLimit(db, `signup:${meta.ip ?? "unknown"}`, 10, 3600);

    const result = await registerUserWithFamily(db, input);

    // Only require email verification if env var is set
    if (requireEmailVerification()) {
      const token = await issueAuthToken(db, result.userId, "email_verification");
      await enqueue(db, "email", {
        to: input.email.toLowerCase(),
        subject: "Verify your Meridian account",
        text: `Welcome to Meridian!\n\nConfirm your email address:\n${verificationUrl(token)}\n\nThis link expires in 48 hours.`
      });

      const session = await import("@/server/security/session");
      const { token: sessionToken } = await session.createSession(db, result.userId, meta);
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
      // Auto-verify for direct signups when verification is disabled
      await markEmailVerified(db, result.userId);

      const session = await import("@/server/security/session");
      const { token: sessionToken } = await session.createSession(db, result.userId, meta);
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

export async function signOutAction(): Promise<void> {
  return signOutSession();
}

const forgotSchema = z.object({ email: z.string().email() });

export async function forgotPasswordAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("auth.forgot_password", async () => {
    const input = forgotSchema.parse(Object.fromEntries(formData));
    const db = getDb();
    const meta = await requestMeta();
    await consumeRateLimit(
      db,
      `reset:${meta.ip ?? "unknown"}:${input.email.toLowerCase()}`,
      5,
      3600
    );

    const token = await requestPasswordReset(db, input.email);
    if (token) {
      await enqueue(db, "email", {
        to: input.email.toLowerCase(),
        subject: "Reset your Meridian password",
        text: `Reset your password using this link (valid for one hour):\n${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}\n\nIf you did not request this, you can ignore this email.`
      });
    }
    return undefined;
  });
}

const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(1),
  confirmPassword: z.string().min(1)
});

export async function resetPasswordAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("auth.reset_password", async () => {
    const raw = resetSchema.parse(Object.fromEntries(formData));
    if (raw.password !== raw.confirmPassword) {
      throw errors.validation("Passwords do not match.");
    }
    await performPasswordReset(getDb(), raw.token, raw.password);
    redirect("/sign-in?reset=ok");
  });
}

const verifySchema = z.object({ token: z.string().min(10) });

export async function verifyEmailAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("auth.verify_email", async () => {
    const input = verifySchema.parse(Object.fromEntries(formData));
    const db = getDb();
    const consumed = await consumeAuthToken(db, input.token, "email_verification");
    if (!consumed) throw errors.validation("This verification link is invalid or has expired.");
    await markEmailVerified(db, consumed.userId);
    redirect("/");
  });
}

export async function resendVerificationAction(): Promise<ActionState> {
  return runAction("auth.resend_verification", async () => {
    const db = getDb();
    const actor = await loadActor();
    if (!actor || actor.emailVerified) return undefined;
    await consumeRateLimit(db, `resend:${actor.userId}`, 3, 3600);
    const token = await issueAuthToken(db, actor.userId, "email_verification");
    await enqueue(db, "email", {
      to: actor.email,
      subject: "Verify your Meridian account",
      text: `Confirm your email address:\n${verificationUrl(token)}\n\nThis link expires in 48 hours.`
    });
    return undefined;
  });
}
