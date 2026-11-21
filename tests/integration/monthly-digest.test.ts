import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, actorOf, joinFamily, truncateAll } from "../helpers";
import { currentFamily } from "@/server/auth/context";
import { jobs } from "@/server/db/schema";
import { ensureDefaultFlags, setFlagEnabled } from "@/server/flags";
import { setUserPreference } from "@/server/domain/users";
import { runMonthlyDigest } from "@/server/domain/monthly-digest";
import { env } from "@/lib/env";

beforeEach(async () => {
  await truncateAll();
});

// Fixed clock: previous month in Etc/UTC is October 2026.
const NOW = new Date("2026-11-15T12:00:00Z");

async function setDigestFlag(on: boolean): Promise<void> {
  await ensureDefaultFlags(db());
  await setFlagEnabled(db(), "monthly_digest_email", on);
}

async function optIn(userId: string, value = true): Promise<void> {
  await setUserPreference(db(), userId, "monthly_digest", value);
}

type EmailJob = { to: string; subject: string; text: string; dedupeKey: string | null };

async function emailJobs(): Promise<EmailJob[]> {
  const rows = await db().select().from(jobs).where(eq(jobs.queue, "email"));
  return rows.map((r) => ({
    ...((r.payload ?? {}) as Omit<EmailJob, "dedupeKey">),
    dedupeKey: r.dedupeKey
  }));
}

async function seedOctoberActivity(
  user: { userId: string; familyId: string; email: string },
  accountName: string
): Promise<string> {
  const accountId = await makeAccount(user, {
    name: accountName,
    openedOn: "2026-09-15",
    openingBalanceDisplayMinor: 100_000
  });
  await addTxn(user, accountId, {
    amountLedgerMinor: -250_000,
    date: "2026-10-10",
    name: "Bait salary description XQZ1"
  });
  await addTxn(user, accountId, {
    amountLedgerMinor: 80_000,
    date: "2026-10-12",
    name: "Bait groceries YQZ2"
  });
  return accountId;
}

describe("monthly digest — flag gate and eligibility", () => {
  it("flag off: an opted-in verified member produces zero email jobs", async () => {
    const user = await makeUser();
    await seedOctoberActivity(user, "BaitVault QQZ9");
    await optIn(user.userId);
    await setDigestFlag(false);

    const result = await runMonthlyDigest(db(), NOW);

    expect(result).toEqual({ families: 0, sent: 0 });
    expect(await emailJobs()).toHaveLength(0);
  });

  it("flag on, opted-in, verified, not removed: exactly one email job with totals only", async () => {
    const user = await makeUser();
    const family = await currentFamily(actorOf(user));
    const accountId = await seedOctoberActivity(user, "BaitVault QQZ9");
    // A current-month flow must not leak into the previous-month digest.
    await addTxn(user, accountId, {
      amountLedgerMinor: 50_000,
      date: "2026-11-05",
      name: "November decoy"
    });
    await optIn(user.userId);
    await setDigestFlag(true);

    const result = await runMonthlyDigest(db(), NOW);

    expect(result).toEqual({ families: 1, sent: 1 });
    const queued = await emailJobs();
    expect(queued).toHaveLength(1);
    const [mail] = queued as [EmailJob];
    expect(mail.dedupeKey).toBe(`digest:${family.id}:${user.userId}:2026-10`);
    expect(mail.to).toBe(user.email);
    expect(mail.subject).toBe("Meridian — October 2026 summary");
    // Seeded figures, formatted in the family currency (USD):
    // income $2,500.00, expense $800.00, savings $1,700.00, net worth $2,700.00.
    expect(mail.text).toContain("October 2026");
    expect(mail.text).toContain(family.name);
    expect(mail.text).toContain("$2,500.00");
    expect(mail.text).toContain("$800.00");
    expect(mail.text).toContain("$1,700.00");
    expect(mail.text).toContain("$2,700.00");
    expect(mail.text).toContain(`View your dashboard: ${env.APP_URL}`);
    // Totals only: no descriptions, no account names, no November decoy.
    expect(mail.text).not.toContain("XQZ1");
    expect(mail.text).not.toContain("YQZ2");
    expect(mail.text).not.toContain("BaitVault QQZ9");
    expect(mail.text).not.toContain("$500.00");
  });

  it("skips members without opt-in, without verification, or removed", async () => {
    const owner = await makeUser();
    const family = await currentFamily(actorOf(owner));
    await seedOctoberActivity(owner, "BaitVault QQZ9");

    const noPref = await makeUser();
    const optedOut = await makeUser();
    const unverified = await makeUser();
    const removed = await makeUser();
    for (const m of [noPref, optedOut, unverified, removed]) {
      await joinFamily(m, family.id);
    }
    await optIn(optedOut.userId, false);
    await optIn(unverified.userId, true);
    await optIn(removed.userId, true);
    await db().execute(
      sql`UPDATE users SET email_verified_at = NULL WHERE id = ${unverified.userId}::uuid`
    );
    await db().execute(sql`UPDATE users SET removed_at = now() WHERE id = ${removed.userId}::uuid`);
    await setDigestFlag(true);

    const result = await runMonthlyDigest(db(), NOW);

    expect(result.sent).toBe(0);
    expect(await emailJobs()).toHaveLength(0);
  });

  it("a family with no accounts and no entries enqueues nothing", async () => {
    const user = await makeUser();
    await optIn(user.userId);
    await setDigestFlag(true);

    const result = await runMonthlyDigest(db(), NOW);

    expect(result).toEqual({ families: 1, sent: 0 });
    expect(await emailJobs()).toHaveLength(0);
  });

  it("re-running the handler enqueues nothing more (dedupeKey holds)", async () => {
    const user = await makeUser();
    await seedOctoberActivity(user, "BaitVault QQZ9");
    await optIn(user.userId);
    await setDigestFlag(true);

    const first = await runMonthlyDigest(db(), NOW);
    const second = await runMonthlyDigest(db(), NOW);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(await emailJobs()).toHaveLength(1);
  });
});

describe("monthly digest — per-recipient visibility", () => {
  it("excludes the owner's unshared account from the member's totals", async () => {
    const owner = await makeUser();
    const family = await currentFamily(actorOf(owner));
    const member = await makeUser();
    await joinFamily(member, family.id);

    const jointId = await makeAccount(owner, { name: "Joint QQZ9", openedOn: "2026-09-15" });
    const privateId = await makeAccount(owner, {
      name: "OwnerOnly QQZ9",
      joint: false,
      openedOn: "2026-09-15"
    });
    await addTxn(owner, jointId, {
      amountLedgerMinor: -100_000,
      date: "2026-10-05",
      name: "Joint salary XQZ1"
    });
    await addTxn(owner, privateId, {
      amountLedgerMinor: -200_000,
      date: "2026-10-06",
      name: "Owner salary XQZ2"
    });
    await optIn(owner.userId);
    await optIn(member.userId);
    await setDigestFlag(true);

    await runMonthlyDigest(db(), NOW);

    const queued = await emailJobs();
    expect(queued).toHaveLength(2);
    const byTo = new Map(queued.map((m) => [m.to, m]));
    const memberMail = byTo.get(member.email)!;
    const ownerMail = byTo.get(owner.email)!;
    // Member sees the joint account only: $1,000.00 income and net worth.
    expect(memberMail.text).toContain("$1,000.00");
    expect(memberMail.text).not.toContain("$3,000.00");
    expect(memberMail.text).not.toContain("XQZ2");
    expect(memberMail.text).not.toContain("OwnerOnly QQZ9");
    // Owner sees both accounts: $3,000.00 income and net worth.
    expect(ownerMail.text).toContain("$3,000.00");
  });
});

describe("monthly digest — incomplete FX", () => {
  it("says amounts were excluded instead of presenting a silently converted total", async () => {
    const user = await makeUser({ currency: "NPR", familyName: "FX Test Family" });
    const cad = await makeAccount(user, { currency: "CAD", openedOn: "2026-09-15" });
    await addTxn(user, cad, {
      amountLedgerMinor: 4_000,
      date: "2026-10-10",
      name: "Bait purchase XQZ1"
    });
    await optIn(user.userId);
    await setDigestFlag(true);

    await runMonthlyDigest(db(), NOW);

    const queued = await emailJobs();
    expect(queued).toHaveLength(1);
    const [mail] = queued as [EmailJob];
    expect(mail.text).toContain("Some amounts were excluded because an exchange rate was missing.");
    expect(mail.text).not.toContain("40.00");
    expect(mail.text).not.toContain("XQZ1");
  });
});
