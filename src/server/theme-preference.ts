import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { findLiveSession } from "@/server/security/session";
import { loadAccessIdentity, SESSION_COOKIE } from "@/server/auth/context";
import { findAccessUser } from "@/server/domain/access-users";
import { usesCloudflareAccess } from "@/server/auth/access";
import { parseThemePreference, type ThemePreference } from "@/lib/theme";

/**
 * Read the signed-in user's saved theme preference WITHOUT touching the
 * session (unlike loadActor, this performs no writes), so the root layout
 * can initialize a missing browser preference. Returns null for anonymous
 * requests, invalid values, and on any failure — theme rendering must
 * never break a page load.
 */
export async function savedThemePreference(): Promise<ThemePreference | null> {
  try {
    const db = getDb();
    if (usesCloudflareAccess()) {
      const identity = await loadAccessIdentity();
      if (!identity) return null;
      const user = await findAccessUser(db, identity);
      return user ? preferenceFromRow(user.preferences) : null;
    }
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const session = await findLiveSession(db, token);
    if (!session) return null;
    const [user] = await db
      .select({ preferences: users.preferences, removedAt: users.removedAt })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (!user || user.removedAt) return null;
    return preferenceFromRow(user.preferences);
  } catch {
    return null;
  }
}

function preferenceFromRow(preferences: unknown): ThemePreference | null {
  if (!preferences || typeof preferences !== "object") return null;
  return parseThemePreference((preferences as Record<string, unknown>)["theme"] as string);
}
