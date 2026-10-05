import { describe, expect, it } from "vitest";
import { MeroShareClient } from "@/server/domain/meroshare";

describe("MeroShareClient", () => {
  it("normalizes a read-only CDSC portfolio without exposing its authorization token", async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, authorization: headers.get("authorization") });
      if (url.pathname.endsWith("/auth/")) {
        return new Response("{}", {
          status: 200,
          headers: { authorization: "Bearer short-lived-token" }
        });
      }
      if (url.pathname.endsWith("/ownDetail/")) {
        return Response.json({
          demat: "1301000000000001",
          clientCode: "CLIENT-1",
          name: "Asha Shrestha"
        });
      }
      if (url.pathname.endsWith("/myPortfolio/")) {
        return Response.json({
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
        });
      }
      if (url.pathname.endsWith("/myTransaction/")) {
        return Response.json({
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
        });
      }
      if (url.pathname.endsWith("/waccReport/")) {
        return Response.json({
          waccReportResponse: [{ scrip: "NABIL", averageBuyRate: "250.625" }]
        });
      }
      return new Response("not found", { status: 404 });
    };

    const snapshot = await new MeroShareClient(
      { clientId: 1, username: "meridian-test", password: "not-recorded" },
      fetchFn
    ).portfolioSnapshot();

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({
      boid: "1301000000000001",
      totalValue: "25062.50"
    });
    expect(snapshot.accounts[0]!.holdings[0]).toMatchObject({
      ticker: "NABIL",
      marketPrice: "250.625",
      marketValue: "25062.5"
    });
    expect(snapshot.accounts[0]!.transactions[0]).toMatchObject({
      ticker: "NABIL",
      quantity: "100",
      activityLabel: "Buy"
    });
    expect(calls.find((call) => call.path.endsWith("/auth/"))?.authorization).toBeNull();
    expect(
      calls
        .filter((call) => !call.path.endsWith("/auth/"))
        .every((call) => call.authorization === "Bearer short-lived-token")
    ).toBe(true);
  });
});
