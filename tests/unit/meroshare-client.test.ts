import { afterEach, describe, expect, it, vi } from "vitest";
import { MeroShareClient } from "@/server/domain/meroshare";
import { log } from "@/lib/logger";

const BOID = "1301000000000001";
const PASSWORD = "test-password-not-recorded";
const TOKEN = "Bearer short-lived-token";

type CapturedCall = {
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
};

type RouteOverrides = {
  portfolio?: (page: number) => Response;
  transactions?: (page: number, body: Record<string, unknown>) => Response;
  wacc?: () => Response;
};

function basePortfolio(): Record<string, unknown> {
  return {
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
  };
}

/** Rows shaped like CDSC's current web client reads them. */
function baseViewTransactions(): Record<string, unknown> {
  return {
    totalItems: 3,
    transactionView: [
      {
        script: "NABIL",
        scriptDesc: "Nabil Bank",
        creditQty: "100",
        debitQty: "0",
        balAfterTrans: "100",
        transactionDate: "2026-08-20",
        historyDesc: "IPO allotment",
        transCode: "IPO"
      },
      {
        script: "NIFRA",
        scriptDesc: "Nepal Infrastructure Bank",
        creditQty: "0",
        debitQty: "40",
        balAfterTrans: "60",
        transactionDate: "2026-09-02",
        historyDesc: "Market sale",
        transCode: "SALE"
      },
      {
        script: "NABIL",
        scriptDesc: "Nabil Bank",
        creditQty: "0",
        debitQty: "0",
        balAfterTrans: "100",
        transactionDate: "2026-09-10",
        historyDesc: "Demat annual fee",
        transCode: "FEE"
      }
    ]
  };
}

function baseWacc(): Record<string, unknown> {
  return { waccReportResponse: [{ scrip: "NABIL", averageBuyRate: "250.625" }] };
}

function makeFetch(overrides: RouteOverrides = {}) {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, authorization: headers.get("authorization"), body });
    if (url.pathname.endsWith("/auth/")) {
      return new Response("{}", { status: 200, headers: { authorization: TOKEN } });
    }
    if (url.pathname.endsWith("/ownDetail/")) {
      return Response.json({ demat: BOID, clientCode: "CLIENT-1", name: "Asha Shrestha" });
    }
    if (url.pathname.endsWith("/myPortfolio/")) {
      return overrides.portfolio
        ? overrides.portfolio(Number(body?.page ?? 1))
        : Response.json(basePortfolio());
    }
    if (url.pathname.endsWith("/myTransaction/")) {
      return overrides.transactions
        ? overrides.transactions(Number(body?.page ?? 1), body ?? {})
        : Response.json(baseViewTransactions());
    }
    if (url.pathname.endsWith("/waccReport/")) {
      return overrides.wacc ? overrides.wacc() : Response.json(baseWacc());
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}

function makeClient(fetchFn: typeof fetch): MeroShareClient {
  return new MeroShareClient(
    { clientId: 1, username: "meridian-test", password: PASSWORD },
    fetchFn
  );
}

function holdingRow(index: number): Record<string, unknown> {
  return {
    script: `S${String(index).padStart(4, "0")}`,
    scriptDesc: `Company ${index}`,
    currentBalance: "10",
    lastTransactionPrice: "100"
  };
}

function viewTransactionRow(page: number, index: number): Record<string, unknown> {
  return {
    script: "NABIL",
    scriptDesc: "Nabil Bank",
    creditQty: "1",
    debitQty: "0",
    transactionDate: "2026-08-20",
    historyDesc: `Entry ${page}-${index}`,
    transCode: `T${page}-${index}`
  };
}

describe("MeroShareClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports the current CDSC transactionView shape with directions and cost basis", async () => {
    const { fetchFn, calls } = makeFetch();
    const snapshot = await makeClient(fetchFn).portfolioSnapshot();

    expect(snapshot.costBasisAvailable).toBe(true);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({ boid: BOID, totalValue: "25062.50" });
    expect(snapshot.accounts[0]!.holdings[0]).toMatchObject({
      ticker: "NABIL",
      marketPrice: "250.625",
      marketValue: "25062.5",
      costBasis: "250.625"
    });

    const transactions = snapshot.accounts[0]!.transactions;
    expect(transactions).toHaveLength(3);
    expect(transactions[0]).toMatchObject({
      ticker: "NABIL",
      quantity: "100",
      activityLabel: "Buy",
      occurredOn: "2026-08-20",
      price: null,
      description: "IPO allotment",
      transactionCode: "IPO"
    });
    expect(transactions[0]!.externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(transactions[1]).toMatchObject({
      ticker: "NIFRA",
      quantity: "40",
      activityLabel: "Sell",
      occurredOn: "2026-09-02"
    });
    // No share movement on either side: kept as an Other book entry.
    expect(transactions[2]).toMatchObject({ quantity: "0", activityLabel: "Other" });

    // The transaction request follows CDSC's current client: `boid`, not `demat`.
    const transactionCall = calls.find((call) => call.path.endsWith("/myTransaction/"));
    expect(transactionCall?.body).toMatchObject({ boid: BOID, clientCode: "CLIENT-1" });
    expect(transactionCall?.body).not.toHaveProperty("demat");

    // The auth call itself is unauthenticated; later calls carry the token.
    expect(calls.find((call) => call.path.endsWith("/auth/"))?.authorization).toBeNull();
    expect(
      calls
        .filter((call) => !call.path.endsWith("/auth/"))
        .every((call) => call.authorization === TOKEN)
    ).toBe(true);
  });

  it("still parses the legacy myTransactionHistory shape via its own mapping", async () => {
    const { fetchFn } = makeFetch({
      transactions: () =>
        Response.json({
          totalItems: 1,
          myTransactionHistory: [
            {
              scrip: "NABIL",
              scripName: "Nabil Bank",
              quantity: "100",
              historyDate: "2026-08-20",
              activityLabel: "Buy",
              remarks: "IPO allotment",
              transactionCode: "IPO"
            }
          ]
        })
    });
    const snapshot = await makeClient(fetchFn).portfolioSnapshot();

    expect(snapshot.accounts[0]!.transactions).toHaveLength(1);
    expect(snapshot.accounts[0]!.transactions[0]).toMatchObject({
      ticker: "NABIL",
      quantity: "100",
      activityLabel: "Buy",
      occurredOn: "2026-08-20"
    });
    // The shared WACC fixture uses averageBuyRate, the current CDSC field.
    expect(snapshot.accounts[0]!.holdings[0]!.costBasis).toBe("250.625");
  });

  it("logs stage and status on upstream failure without leaking secrets", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const { fetchFn } = makeFetch({
      transactions: () => new Response("bad request", { status: 400 })
    });

    await expect(makeClient(fetchFn).portfolioSnapshot()).rejects.toThrow(
      "MeroShare could not complete that request. (stage: transactions)"
    );

    const upstreamEntries = [...warnSpy.mock.calls, ...infoSpy.mock.calls]
      .map((call) => call[0])
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>).action === "meroshare.upstream"
      );
    const failure = upstreamEntries.find(
      (entry) => entry.stage === "transactions" && entry.status === 400
    );
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ method: "POST" });
    expect(typeof failure!.durationMs).toBe("number");

    // One correlation ID is shared by every request in the snapshot.
    const correlationIds = new Set(upstreamEntries.map((entry) => entry.correlationId));
    expect(correlationIds.size).toBe(1);
    expect(typeof [...correlationIds][0]).toBe("string");

    // No credentials, token, or BOID appear in any logged field.
    const serialized = JSON.stringify([...warnSpy.mock.calls, ...infoSpy.mock.calls]);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("short-lived-token");
    expect(serialized).not.toContain(BOID);
  });

  it("proceeds without cost basis when the WACC request fails upstream", async () => {
    const { fetchFn } = makeFetch({
      wacc: () => new Response("internal error", { status: 500 })
    });
    const snapshot = await makeClient(fetchFn).portfolioSnapshot();

    expect(snapshot.costBasisAvailable).toBe(false);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("Cost basis unavailable");
    expect(snapshot.accounts[0]!.holdings[0]!.costBasis).toBeNull();
    expect(snapshot.accounts[0]!.transactions).toHaveLength(3);
  });

  it("does not swallow a WACC session rejection as partial success", async () => {
    const { fetchFn } = makeFetch({
      wacc: () => new Response("unauthorized", { status: 401 })
    });
    await expect(makeClient(fetchFn).portfolioSnapshot()).rejects.toThrow(
      "The MeroShare session was rejected. Reconnect the account. (stage: wacc)"
    );
  });

  it("does not swallow an unreadable WACC 200 response as partial success", async () => {
    const { fetchFn } = makeFetch({
      wacc: () => new Response("this is not json", { status: 200 })
    });
    await expect(makeClient(fetchFn).portfolioSnapshot()).rejects.toThrow(
      "MeroShare returned an unreadable response. (stage: wacc)"
    );
  });

  it("paginates the portfolio until totalItems is reached", async () => {
    const pages: number[] = [];
    const { fetchFn } = makeFetch({
      portfolio: (page) => {
        pages.push(page);
        const start = (page - 1) * 200;
        const count = page === 1 ? 200 : 50;
        return Response.json({
          totalItems: 250,
          meroShareMyPortfolio: Array.from({ length: count }, (_, i) => holdingRow(start + i))
        });
      }
    });
    const snapshot = await makeClient(fetchFn).portfolioSnapshot();

    expect(pages).toEqual([1, 2]);
    expect(snapshot.accounts[0]!.holdings).toHaveLength(250);
  });

  it("paginates transactions while pages are full when no total is provided", async () => {
    const pages: number[] = [];
    const { fetchFn } = makeFetch({
      transactions: (page) => {
        pages.push(page);
        const count = page < 3 ? 200 : 37;
        return Response.json({
          transactionView: Array.from({ length: count }, (_, i) => viewTransactionRow(page, i))
        });
      }
    });
    const snapshot = await makeClient(fetchFn).portfolioSnapshot();

    expect(pages).toEqual([1, 2, 3]);
    expect(snapshot.accounts[0]!.transactions).toHaveLength(437);
  });

  it("throws instead of truncating when holdings exceed the import cap", async () => {
    const { fetchFn } = makeFetch({
      portfolio: (page) =>
        Response.json({
          totalItems: 5000,
          meroShareMyPortfolio: Array.from({ length: 200 }, (_, i) =>
            holdingRow((page - 1) * 200 + i)
          )
        })
    });
    await expect(makeClient(fetchFn).portfolioSnapshot()).rejects.toThrow(
      "MeroShare returned more holdings than Meridian can safely import."
    );
  });
});
