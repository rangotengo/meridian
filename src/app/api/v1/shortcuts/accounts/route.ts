import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { authenticateApiRequest } from "@/server/auth/api-auth";
import { accessibleAccountIds } from "@/server/authorization/access";
import { getDb } from "@/server/db/client";
import { accounts, categories } from "@/server/db/schema";
import { apiErrorResponse } from "../http";

export async function GET(req: Request) {
  try {
    const actor = await authenticateApiRequest(req);
    const db = getDb();

    // Only accounts the actor can see (joint, owned, or explicitly shared) —
    // never other members' private accounts.
    const visibleIds = await accessibleAccountIds(db, actor);

    const userAccounts =
      visibleIds.length === 0
        ? []
        : await db
            .select({
              id: accounts.id,
              name: accounts.name,
              institution: accounts.institution,
              type: accounts.type,
              currency: accounts.currency,
              status: accounts.status
            })
            .from(accounts)
            .where(
              and(
                eq(accounts.familyId, actor.familyId),
                eq(accounts.status, "active"),
                inArray(accounts.id, visibleIds)
              )
            );

    const userCategories = await db
      .select({
        id: categories.id,
        name: categories.name,
        color: categories.color
      })
      .from(categories)
      .where(eq(categories.familyId, actor.familyId));

    return NextResponse.json({
      ok: true,
      accounts: userAccounts,
      categories: userCategories
    });
  } catch (err: unknown) {
    return apiErrorResponse(err, "shortcuts.accounts");
  }
}
