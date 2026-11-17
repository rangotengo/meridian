import { eq } from "drizzle-orm";
import { Executor } from "../db/client";
import { featureFlags } from "../db/schema";

export const FLAG_KEYS = ["net_worth_projections", "monthly_digest_email"] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export const DEFAULT_FLAGS: Record<FlagKey, { enabled: boolean; description: string }> = {
  net_worth_projections: {
    enabled: false,
    description: "Project net worth into the next quarter from scheduled recurring flows."
  },
  monthly_digest_email: {
    enabled: false,
    description: "Preview: send a monthly summary email to family members."
  }
};

export async function ensureDefaultFlags(exec: Executor): Promise<void> {
  for (const [key, def] of Object.entries(DEFAULT_FLAGS)) {
    await exec
      .insert(featureFlags)
      .values({ key, enabled: def.enabled, description: def.description })
      .onConflictDoNothing();
  }
}

export async function isFlagEnabled(exec: Executor, key: FlagKey): Promise<boolean> {
  const [row] = await exec.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
  return row?.enabled ?? DEFAULT_FLAGS[key]?.enabled ?? false;
}

export async function listFlags(exec: Executor) {
  return exec.select().from(featureFlags).orderBy(featureFlags.key);
}

export async function setFlagEnabled(
  exec: Executor,
  key: string,
  enabled: boolean
): Promise<boolean> {
  if (!(FLAG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown feature flag: ${key}`);
  }
  const [row] = await exec
    .update(featureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(featureFlags.key, key))
    .returning();
  return row?.enabled ?? false;
}
