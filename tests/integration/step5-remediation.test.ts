import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, makeUser, makeAccount, truncateAll, actorOf } from "../helpers";
import { meroShareConnections, sessions, budgets } from "@/server/db/schema";
import { hashToken } from "@/lib/crypto";
import * as meroshareSvc from "@/server/domain/meroshare";
import * as usersSvc from "@/server/domain/users";
import * as familiesSvc from "@/server/domain/families";
import * as accountsSvc from "@/server/domain/accounts";
import { netWorthMinorForAccounts } from "@/server/domain/reports";
import { upsertRate } from "@/server/domain/exchange-rates";
import { issueAuthToken, consumeAuthToken } from "@/server/security/auth-tokens";
import { POST as chatPostHandler } from "@/app/api/chat/route";

beforeAll(async () => {
  await truncateAll();
});

describe("S10: Safe MeroShare Connection DTO", () => {
  it("scrubs encrypted credentials from listMeroShareConnections client props", async () => {
    const user = await makeUser();
    await db().insert(meroShareConnections).values({
      familyId: user.familyId,
      userId: user.userId,
      name: "Test Portfolio",
      clientId: 100,
      dpCode: "13200",
      dpName: "Test Capital Ltd",
      usernameEncrypted: "sensitive_cipher_username",
      passwordEncrypted: "sensitive_cipher_password"
    });

    const results = await meroshareSvc.listMeroShareConnections(db(), actorOf(user));
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    const conn = results[0]!.connection as Record<string, unknown>;

    expect(conn.name).toBe("Test Portfolio");
    expect(conn.dpCode).toBe("13200");
    expect(conn.dpName).toBe("Test Capital Ltd");
    expect(conn.usernameEncrypted).toBeUndefined();
    expect(conn.passwordEncrypted).toBeUndefined();
  });
});

describe("S11: Chat Route CSRF and Payload Controls", () => {
  it("rejects cross-origin requests with 403 Forbidden", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        origin: "https://malicious-site.example",
        "content-type": "application/json"
      },
      body: JSON.stringify({ message: "Hello" })
    });
    const res = await chatPostHandler(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/origin/i);
  });

  it("rejects non-JSON requests with 415 Unsupported Media Type", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "text/plain"
      },
      body: "Hello"
    });
    const res = await chatPostHandler(req);
    expect(res.status).toBe(415);
  });

  it("rejects oversized request payloads with 413 Payload Too Large", async () => {
    const hugeMessage = "A".repeat(35000);
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json"
      },
      body: JSON.stringify({ message: hugeMessage })
    });
    const res = await chatPostHandler(req);
    expect(res.status).toBe(413);
  });
});

describe("S12: Identity Lifecycle & Sensitive Token Revocation", () => {
  it("revokes all existing sessions upon password reset atomically", async () => {
    const user = await makeUser();
    const token = await usersSvc.requestPasswordReset(db(), user.email);
    expect(token).toBeTruthy();

    const { createSession } = await import("@/server/security/session");
    const session = await createSession(db(), user.userId, { ip: "127.0.0.1" });

    // Verify session exists
    const [sessBefore] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(session.token)));
    expect(sessBefore).toBeDefined();

    // Perform password reset
    await usersSvc.performPasswordReset(db(), token!, "NewSuperPassword123!");

    // Verify session revoked
    const [sessAfter] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(session.token)));
    expect(sessAfter).toBeUndefined();

    // Verify reset token cannot be reused
    await expect(
      usersSvc.performPasswordReset(db(), token!, "AnotherPassword123!")
    ).rejects.toMatchObject({ code: "validation.failed" });
  });

  it("invalidates auth tokens and sessions when email changes", async () => {
    const user = await makeUser();
    const token = await issueAuthToken(db(), user.userId, "email_verification");
    const { createSession } = await import("@/server/security/session");
    const session = await createSession(db(), user.userId, { ip: "127.0.0.1" });

    await usersSvc.changeEmail(
      db(),
      actorOf(user),
      "Sup3rSecure!Pass",
      `updated-${Date.now()}@test.local`
    );

    // Verify previous auth token is invalidated
    const consumed = await consumeAuthToken(db(), token, "email_verification");
    expect(consumed).toBeNull();

    // Verify previous session is revoked
    const [sess] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(session.token)));
    expect(sess).toBeUndefined();
  });
});

describe("F10: Net Worth Respects Report Inclusion Filter", () => {
  it("excludes non-report accounts from sidebar aggregate net worth", async () => {
    const user = await makeUser();
    await makeAccount(user, {
      openingBalanceDisplayMinor: 10000,
      includedInReports: true
    });
    await makeAccount(user, {
      openingBalanceDisplayMinor: 50000,
      includedInReports: false
    });

    const accounts = await accountsSvc.listAccountsForActor(db(), actorOf(user));
    const active = accounts.filter((a) => a.status === "active");
    const reportAccounts = active.filter((a) => a.includedInReports);

    const family = (await familiesSvc.getFamilyById(db(), user.familyId))!;
    const { netWorthMinor: netWorth } = await netWorthMinorForAccounts(
      db(),
      family,
      reportAccounts.map((a) => ({
        displayBalanceMinor: a.displayBalanceMinor,
        currency: a.currency
      })),
      new Date().toISOString().slice(0, 10)
    );

    expect(netWorth).toBe(10000);
  });
});

describe("F12: Currency Change Migrates Active Budget Limits", () => {
  it("converts budget amounts when family base currency is updated", async () => {
    const user = await makeUser();
    const today = new Date().toISOString().slice(0, 10);

    await upsertRate(db(), {
      base: "USD",
      quote: "EUR",
      rate: "0.90",
      quotedOn: today
    });

    const [budget] = await db()
      .insert(budgets)
      .values({
        familyId: user.familyId,
        amountMinor: 10000,
        active: true
      })
      .returning();

    expect(budget).toBeDefined();
    await familiesSvc.updateFamilySettings(db(), actorOf(user), { currency: "EUR" });

    const [updated] = await db().select().from(budgets).where(eq(budgets.id, budget!.id));
    expect(updated).toBeDefined();
    expect(updated!.amountMinor).toBe(9000);
  });
});
