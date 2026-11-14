import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, makeUser, makeSuperAdmin, truncateAll, actorOf, daysAgo } from "../helpers";
import { upsertRateForActor, getRateInfo } from "@/server/domain/exchange-rates";

beforeAll(async () => {
  await truncateAll();
});

// Seam under test: upsertRateForActor. The server action
// (upsertExchangeRateAction) cannot be invoked in this harness — it needs
// Next.js request scope for requireSuperAdmin's cookie load and redirect —
// so the action is a thin wrapper that authenticates via requireSuperAdmin
// and delegates all authorization, audit, and writing to this function.
// Testing here proves the guard that actually decides the write.
describe("exchange-rate writes are restricted to platform super-admins", () => {
  it("rejects an ordinary verified member", async () => {
    const member = await makeUser();
    await expect(
      upsertRateForActor(db(), actorOf(member, "member"), {
        base: "USD",
        quote: "NPR",
        rate: "133.50",
        quotedOn: daysAgo(0)
      })
    ).rejects.toMatchObject({ code: "access.denied" });

    expect(await getRateInfo(db(), "USD", "NPR", daysAgo(0))).toBeNull();
    const events = await db().execute<{ c: string }>(sql`
      SELECT count(*)::text AS c FROM audit_events WHERE action = 'exchange_rate.upserted'
    `);
    expect(Number(events.rows![0]!.c)).toBe(0);
  });

  it("rejects a family admin from another household", async () => {
    // A family admin can manage their own household's money, but rates are
    // instance-wide: another household's admin must not overwrite them.
    const otherAdmin = await makeUser();
    await expect(
      upsertRateForActor(db(), actorOf(otherAdmin, "admin"), {
        base: "EUR",
        quote: "NPR",
        rate: "145",
        quotedOn: daysAgo(0)
      })
    ).rejects.toMatchObject({ code: "access.denied" });

    expect(await getRateInfo(db(), "EUR", "NPR", daysAgo(0))).toBeNull();
  });

  it("lets a super-admin write and records an instance-level audit event", async () => {
    const admin = await makeSuperAdmin();
    const actor = { ...actorOf(admin), platformRole: "super_admin" as const };

    await upsertRateForActor(db(), actor, {
      base: "GBP",
      quote: "NPR",
      rate: "170.25",
      quotedOn: daysAgo(0)
    });

    const stored = await getRateInfo(db(), "GBP", "NPR", daysAgo(0));
    // The rate column is numeric(?, 8): Postgres returns the stored value
    // with its scale ("170.25000000"), so compare numerically.
    expect(stored).toMatchObject({ base: "GBP", quote: "NPR" });
    expect(Number(stored?.rate)).toBe(170.25);

    // Instance-level event: no family scope, attributed to the acting admin.
    const events = await db().execute<{
      family_id: string | null;
      actor_user_id: string;
      entity_id: string;
      metadata: { rate: string };
    }>(sql`
      SELECT family_id, actor_user_id, entity_id, metadata FROM audit_events
      WHERE action = 'exchange_rate.upserted' ORDER BY created_at DESC LIMIT 1
    `);
    const event = events.rows![0]!;
    expect(event.family_id).toBeNull();
    expect(event.actor_user_id).toBe(admin.userId);
    expect(event.entity_id).toBe(`GBP:NPR:${daysAgo(0)}`);
    expect(event.metadata.rate).toBe("170.25");
  });
});
