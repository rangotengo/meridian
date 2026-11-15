import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { actorOf, db, makeUser, truncateAll } from "../helpers";
import { connectMeroShare, syncMeroShareConnection } from "@/server/domain/meroshare";
import { meroShareAccounts, meroShareHoldings } from "@/server/db/schema";

// connectMeroShare encrypts credentials with the runtime env key, which
// @/lib/env parses at import time — set a throwaway key before any module
// in this file's graph loads.
vi.hoisted(() => {
  process.env.MERO_SHARE_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
});

const BOID = "1301000000000001";
const TOKEN = "Bearer short-lived-token";

type Routes = {
  portfolio: (page: number) => Response;
  wacc: () => Response;
};

function holdingRow(index: number): Record<string, unknown> {
  return {
    script: `S${String(index).padStart(4, "0")}`,
    scriptDesc: `Company ${index}`,
    currentBalance: "10",
    lastTransactionPrice: "100"
  };
}

function installUpstream(routes: Routes): void {
  const fetchStub: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (url.pathname.endsWith("/auth/")) {
      return new Response("{}", { status: 200, headers: { authorization: TOKEN } });
    }
    if (url.pathname.endsWith("/ownDetail/")) {
      return Response.json({ demat: BOID, clientCode: "CLIENT-1", name: "Asha Shrestha" });
    }
    if (url.pathname.endsWith("/myPortfolio/")) {
      return routes.portfolio(Number(body?.page ?? 1));
    }
    if (url.pathname.endsWith("/myTransaction/")) {
      return Response.json({
        totalItems: 1,
        transactionView: [
          {
            script: "NABIL",
            scriptDesc: "Nabil Bank",
            creditQty: "100",
            debitQty: "0",
            transactionDate: "2026-08-20",
            historyDesc: "IPO allotment",
            transCode: "IPO"
          }
        ]
      });
    }
    if (url.pathname.endsWith("/waccReport/")) {
      return routes.wacc();
    }
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", fetchStub);
}

async function storedHoldings(connectionId: string) {
  const [account] = await db()
    .select()
    .from(meroShareAccounts)
    .where(eq(meroShareAccounts.connectionId, connectionId));
  if (!account) throw new Error("MeroShare account was not created");
  return db()
    .select()
    .from(meroShareHoldings)
    .where(eq(meroShareHoldings.meroShareAccountId, account.id))
    .orderBy(meroShareHoldings.ticker);
}

const capital = { id: 1, code: "TEST", name: "Test Capital Ltd" };
const credentials = { clientId: 1, username: "demat-user", password: "pw" };

describe("MeroShare sync (persisted)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves stored cost basis when a later sync hits a WACC outage", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    let waccDown = false;
    installUpstream({
      portfolio: () =>
        Response.json({
          totalItems: 1,
          totalValueOfLastTransPrice: "25062.50",
          meroShareMyPortfolio: [
            {
              script: "NABIL",
              scriptDesc: "Nabil Bank",
              currentBalance: "100",
              lastTransactionPrice: "250.625"
            }
          ]
        }),
      wacc: () =>
        waccDown
          ? new Response("service unavailable", { status: 503 })
          : Response.json({ waccReportResponse: [{ scrip: "NABIL", averageBuyRate: "250.625" }] })
    });

    const connected = await connectMeroShare(db(), actor, { ...credentials, capital });
    const before = await storedHoldings(connected.connectionId);
    expect(before).toHaveLength(1);
    expect(before[0]!.costBasisMinor).toBe(25063);

    waccDown = true;
    const synced = await syncMeroShareConnection(db(), actor, connected.connectionId);
    expect(synced.costBasisAvailable).toBe(false);
    expect(synced.warnings[0]).toContain("Cost basis unavailable");

    const after = await storedHoldings(connected.connectionId);
    expect(after).toHaveLength(1);
    expect(after[0]!.costBasisMinor).toBe(25063);
  });

  it("fails the sync and leaves all holdings untouched when a later page is empty", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    let truncated = false;
    installUpstream({
      portfolio: (page) => {
        if (page === 1) {
          return Response.json({
            totalItems: 250,
            totalValueOfLastTransPrice: "250000",
            meroShareMyPortfolio: Array.from({ length: 200 }, (_, i) => holdingRow(i))
          });
        }
        return truncated
          ? Response.json({ totalItems: 250, meroShareMyPortfolio: [] })
          : Response.json({
              totalItems: 250,
              meroShareMyPortfolio: Array.from({ length: 50 }, (_, i) => holdingRow(200 + i))
            });
      },
      wacc: () => Response.json({ waccReportResponse: [] })
    });

    const connected = await connectMeroShare(db(), actor, { ...credentials, capital });
    const before = await storedHoldings(connected.connectionId);
    expect(before).toHaveLength(250);

    truncated = true;
    await expect(syncMeroShareConnection(db(), actor, connected.connectionId)).rejects.toThrow(
      "MeroShare returned an incomplete portfolio response. (stage: portfolio)"
    );

    const after = await storedHoldings(connected.connectionId);
    expect(after).toHaveLength(250);
    expect(after).toEqual(before);
  });
});
