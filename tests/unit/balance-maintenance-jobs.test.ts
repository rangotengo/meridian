import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "@/server/db/client";

vi.mock("@/server/domain/balances-maintenance", () => ({
  recalculateAllActiveAccounts: vi.fn()
}));

import { recalculateAllActiveAccounts } from "@/server/domain/balances-maintenance";
import { createJobRegistry, runBalanceMaintenance } from "@/server/queue/jobs";

const mockRecalc = vi.mocked(recalculateAllActiveAccounts);
const exec = {} as Executor;

beforeEach(() => {
  mockRecalc.mockReset();
});

describe("runBalanceMaintenance", () => {
  it("resolves with the result when every account recalculates", async () => {
    mockRecalc.mockResolvedValue({ recalculated: 4, failures: [] });
    await expect(runBalanceMaintenance(exec)).resolves.toEqual({
      recalculated: 4,
      failures: []
    });
  });

  it("throws when any account failed, naming the failed accounts, so the queue retries the repair job", async () => {
    mockRecalc.mockResolvedValue({
      recalculated: 3,
      failures: [{ accountId: "acct-9", error: "transient database error" }]
    });
    await expect(runBalanceMaintenance(exec)).rejects.toThrow(/failed for 1 account\(s\): acct-9/);
  });

  it("propagates failures through the registered maintenance:balances queue handler", async () => {
    mockRecalc.mockResolvedValue({
      recalculated: 0,
      failures: [{ accountId: "acct-1", error: "boom" }]
    });
    const registry = await createJobRegistry();
    const handler = registry.get("maintenance:balances");
    expect(handler).toBeDefined();
    await expect(handler!({}, exec)).rejects.toThrow(/acct-1/);
  });

  it("lets the registered handler succeed when all accounts recalculate", async () => {
    mockRecalc.mockResolvedValue({ recalculated: 2, failures: [] });
    const registry = await createJobRegistry();
    const handler = registry.get("maintenance:balances");
    await expect(handler!({}, exec)).resolves.toBeUndefined();
  });
});
