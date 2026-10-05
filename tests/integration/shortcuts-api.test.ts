import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  joinFamily,
  truncateAll,
  actorOf,
  type TestUser
} from "../helpers";
import * as apiKeysSvc from "@/server/domain/api-keys";
import * as accountsSvc from "@/server/domain/accounts";
import * as usersSvc from "@/server/domain/users";
import { entries as entriesTable, apiKeys as apiKeysTable } from "@/server/db/schema";
import { GET as listAccountsRoute } from "@/app/api/v1/shortcuts/accounts/route";
import { POST as parseRoute } from "@/app/api/v1/shortcuts/parse/route";
import { POST as transactionRoute } from "@/app/api/v1/shortcuts/transaction/route";

const BASE = "https://meridian.test";

function apiRequest(
  path: string,
  init: {
    method?: string;
    key?: string | null;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers ?? {})
  };
  if (init.key) headers["authorization"] = `Bearer ${init.key}`;
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
}

async function makeKeyFor(user: TestUser, name = "shortcut key") {
  return apiKeysSvc.createApiKey(db(), actorOf(user), { name });
}

beforeAll(async () => {
  await truncateAll();
});

describe("shortcuts API authentication", () => {
  it("rejects requests without an API key with 401", async () => {
    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: null,
        body: { amount: 10 }
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects a revoked API key with 401", async () => {
    const user = await makeUser();
    const key = await makeKeyFor(user);
    await apiKeysSvc.revokeApiKey(db(), actorOf(user), key.id);

    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: 10 }
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects an API key whose member was removed, with 401", async () => {
    const owner = await makeUser();
    const member = await makeUser({ email: `removed-${Date.now()}@test.local` });
    await joinFamily(member, owner.familyId);
    const key = await makeKeyFor(member, "member key");

    await usersSvc.removeMember(db(), actorOf(owner, "admin"), member.userId);

    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: 10 }
      })
    );
    expect(res.status).toBe(401);

    // The stored key row is revoked as part of member removal, so the key is
    // dead at the data layer too, not just because the user is deactivated.
    const rows = await db().select().from(apiKeysTable);
    const stored = rows.find((r) => r.userId === member.userId);
    expect(stored?.revokedAt).toBeTruthy();
  });

  it("never grants API key actors the platform super-admin role", async () => {
    const user = await makeUser();
    const key = await makeKeyFor(user, "super key");
    await db().execute(
      sql`UPDATE users SET platform_role = 'super_admin' WHERE id = ${user.userId}::uuid`
    );

    const actor = await apiKeysSvc.verifyApiKey(db(), key.rawKey);
    expect(actor).not.toBeNull();
    expect(actor?.platformRole).toBe("user");
  });
});

describe("shortcuts API account visibility", () => {
  it("hides other members' private accounts from the accounts listing", async () => {
    const owner = await makeUser({ familyName: "Visibility" });
    const member = await makeUser({ email: `viewer-${Date.now()}@test.local` });
    await joinFamily(member, owner.familyId);

    await makeAccount(owner, { joint: false, name: "Secret Private Card" });
    const jointId = await makeAccount(owner, { joint: true, name: "Shared Checking" });

    const key = await makeKeyFor(member);
    const res = await listAccountsRoute(
      apiRequest("/api/v1/shortcuts/accounts", { key: key.rawKey })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const names: string[] = body.accounts.map((a: { name: string }) => a.name);
    expect(names).toContain("Shared Checking");
    expect(names).not.toContain("Secret Private Card");
    expect(body.accounts.every((a: { id: string }) => a.id === jointId)).toBe(true);
  });

  it("never matches another member's private account, even by explicit id", async () => {
    const owner = await makeUser({ familyName: "MatchGuard" });
    const member = await makeUser({ email: `matcher-${Date.now()}@test.local` });
    await joinFamily(member, owner.familyId);

    const privateId = await makeAccount(owner, {
      joint: false,
      name: "Secret 445566",
      institution: "Nabil Bank"
    });
    const jointId = await makeAccount(owner, { joint: true, name: "Fallback Checking" });

    const key = await makeKeyFor(member);

    // Explicit id of a private account: matcher must not return it.
    const parseRes = await parseRoute(
      apiRequest("/api/v1/shortcuts/parse", {
        method: "POST",
        key: key.rawKey,
        body: { rawSms: "NPR 100.00 debited from A/C 445566", accountId: privateId }
      })
    );
    expect(parseRes.status).toBe(200);
    const parseBody = await parseRes.json();
    expect(parseBody.accountMatch?.id ?? null).not.toBe(privateId);

    // SMS whose digits point at the private account still lands on a writable one.
    const txnRes = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { rawSms: "Your A/C 445566 debited by NPR 100.00", sender: "Nabil_Alert" }
      })
    );
    expect(txnRes.status).toBe(200);
    const txnBody = await txnRes.json();
    expect(txnBody.entry.account.id).toBe(jointId);
  });

  it("does not choose accounts shared read_only", async () => {
    const owner = await makeUser({ familyName: "ReadOnly" });
    const member = await makeUser({ email: `ro-${Date.now()}@test.local` });
    await joinFamily(member, owner.familyId);

    // The member's only visibility into an account is a read_only share.
    const accountId = await makeAccount(owner, { joint: false, name: "Look But Do Not Touch" });
    await accountsSvc.shareAccount(db(), actorOf(owner), accountId, member.userId, "read_only");

    const key = await makeKeyFor(member);
    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: 5, accountId }
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe("shortcuts API request hardening", () => {
  it("rejects cross-site POSTs via Origin header", async () => {
    const user = await makeUser();
    const key = await makeKeyFor(user);
    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        headers: { origin: "https://evil.example" },
        body: { amount: 10 }
      })
    );
    expect(res.status).toBe(403);
  });

  it("rejects cross-site POSTs via Sec-Fetch-Site", async () => {
    const user = await makeUser();
    const key = await makeKeyFor(user);
    const res = await parseRoute(
      apiRequest("/api/v1/shortcuts/parse", {
        method: "POST",
        key: key.rawKey,
        headers: { "sec-fetch-site": "cross-site" },
        body: { rawSms: "NPR 100 debited" }
      })
    );
    expect(res.status).toBe(403);
  });

  it("rejects non-JSON content types with 415", async () => {
    const user = await makeUser();
    const key = await makeKeyFor(user);
    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        headers: { "content-type": "text/plain" },
        body: { amount: 10 }
      })
    );
    expect(res.status).toBe(415);
  });
});

describe("shortcuts API money and date handling", () => {
  it("accepts exponent-0 currencies without scaling to hundreds", async () => {
    const user = await makeUser({ familyName: "JpyFam" });
    const accountId = await makeAccount(user, { joint: true, name: "JPY Cash", currency: "JPY" });
    const key = await makeKeyFor(user);

    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: "1000", accountId }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.amount).toBe(1000);

    const [entry] = await db()
      .select()
      .from(entriesTable)
      .where(eq(entriesTable.id, body.entry.id));
    expect(entry?.amountMinor).toBe(1000);
  });

  it("rejects amounts with precision beyond the account currency's exponent", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { joint: true, name: "USD Checking" });
    const key = await makeKeyFor(user);

    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: "10.005", accountId }
      })
    );
    expect(res.status).toBe(422);
  });

  it("rejects negative, zero, and non-finite amounts", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { joint: true });
    const key = await makeKeyFor(user);

    for (const amount of [-10, 0, "abc"]) {
      const res = await transactionRoute(
        apiRequest("/api/v1/shortcuts/transaction", {
          method: "POST",
          key: key.rawKey,
          body: { amount, accountId }
        })
      );
      expect([400, 422]).toContain(res.status);
    }
  });

  it("rejects invalid dates with 400 instead of silently using today", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { joint: true });
    const key = await makeKeyFor(user);

    for (const date of ["2026-02-30", "31/12/2026", "not-a-date"]) {
      const res = await transactionRoute(
        apiRequest("/api/v1/shortcuts/transaction", {
          method: "POST",
          key: key.rawKey,
          body: { amount: 10, accountId, date }
        })
      );
      expect(res.status).toBe(400);
    }
  });
});

describe("API key management scoping", () => {
  it("lets members see and revoke only their own keys", async () => {
    const owner = await makeUser({ familyName: "KeyScope" });
    const memberA = await makeUser({ email: `membera-${Date.now()}@test.local` });
    const memberB = await makeUser({ email: `memberb-${Date.now()}@test.local` });
    await joinFamily(memberA, owner.familyId);
    await joinFamily(memberB, owner.familyId);
    await makeAccount(owner, { joint: true, name: "KeyScope Joint" });

    const keyA = await makeKeyFor(memberA, "A key");
    const keyB = await makeKeyFor(memberB, "B key");

    const listA = await apiKeysSvc.listApiKeysForActor(db(), actorOf(memberA, "member"));
    expect(listA.map((k) => k.id)).toContain(keyA.id);
    expect(listA.map((k) => k.id)).not.toContain(keyB.id);

    await expect(
      apiKeysSvc.revokeApiKey(db(), actorOf(memberA, "member"), keyB.id)
    ).rejects.toMatchObject({ code: "resource.not_found", status: 404 });

    // B's key still works after A's revocation attempt.
    const res = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: keyB.rawKey,
        body: { amount: 10 }
      })
    );
    expect(res.status).toBe(200);

    // The family admin may revoke any member's key.
    await expect(
      apiKeysSvc.revokeApiKey(db(), actorOf(owner, "admin"), keyB.id)
    ).resolves.toBeUndefined();
  });

  it("lets family admins list every key in the family with owner names", async () => {
    const owner = await makeUser({ familyName: "AdminList" });
    const member = await makeUser({ email: `listed-${Date.now()}@test.local` });
    await joinFamily(member, owner.familyId);

    await makeKeyFor(owner, "owner key");
    const memberKey = await makeKeyFor(member, "member key");

    const list = await apiKeysSvc.listApiKeysForActor(db(), actorOf(owner, "admin"));
    const ids = list.map((k) => k.id);
    expect(ids).toContain(memberKey.id);
    const listed = list.find((k) => k.id === memberKey.id);
    expect(listed?.userName).toBeTruthy();
  });
});

describe("shortcuts API deduplication", () => {
  it("detects duplicates by externalId", async () => {
    const user = await makeUser({ familyName: "Dedup" });
    const accountId = await makeAccount(user, { joint: true });
    const key = await makeKeyFor(user);
    const externalId = `dup-${Date.now()}`;

    const first = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: 42, accountId, externalId, name: "Dedup test" }
      })
    );
    expect(first.status).toBe(200);
    expect((await first.json()).duplicated).toBe(false);

    const second = await transactionRoute(
      apiRequest("/api/v1/shortcuts/transaction", {
        method: "POST",
        key: key.rawKey,
        body: { amount: 42, accountId, externalId, name: "Dedup test" }
      })
    );
    expect(second.status).toBe(200);
    expect((await second.json()).duplicated).toBe(true);
  });
});
