"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { loadActor, SESSION_COOKIE } from "@/server/auth/context";
import { revokeSession } from "@/server/security/session";
import { getUserPrivacyMode, setUserPreference } from "@/server/domain/users";
import { usesCloudflareAccess } from "@/server/auth/access";
import { isThemePreference, THEME_COOKIE_MAX_AGE_SECONDS, THEME_COOKIE_NAME } from "@/lib/theme";

export async function signOutAction(): Promise<void> {
  if (usesCloudflareAccess()) {
    (await cookies()).delete(SESSION_COOKIE);
    redirect("/cdn-cgi/access/logout");
  }
  const db = getDb();
  const actor = await loadActor();
  if (actor) {
    await revokeSession(db, actor.sessionId);
  }
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/sign-in");
}

export async function togglePrivacyAction(): Promise<void> {
  const db = getDb();
  const actor = await loadActor();
  if (!actor) return;
  const current = await getUserPrivacyMode(db, actor.userId);
  await setUserPreference(db, actor.userId, "privacy_mode", !current);
  revalidatePath("/", "layout");
}

export async function setThemePreferenceAction(theme: "light" | "dark" | "system"): Promise<void> {
  if (!isThemePreference(theme)) return;
  const store = await cookies();
  store.set(THEME_COOKIE_NAME, theme, {
    path: "/",
    maxAge: THEME_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax"
  });
  const actor = await loadActor();
  if (actor) {
    await setUserPreference(getDb(), actor.userId, "theme", theme);
  }
}
