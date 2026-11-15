import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "@/server/db/client";

vi.mock("@/server/domain/balances-maintenance", () => ({
  recalculateAllActiveAccounts: vi.fn(),
  recalculateTargetedAccounts: vi.fn()
}));

import {
  recalculateAllActiveAccounts,
  recalculateTargetedAccounts
} from "@/server/domain/balances-maintenance";
import { createJobRegistry, runBalanceMaintenance } from "@/server/queue/jobs";

const mockRecalc = vi.mocked(recalculateAllActiveAccounts);
const mockTargeted = vi.mocked(recalculateTargetedAccounts);
const exec = {} as Executor;

beforeEach(() => {
  mockRecalc.mockReset();
  mockTargeted.mockReset();
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

  it("targets only the payload's accounts when accountIds are present", async () => {
    mockTargeted.mockResolvedValue({ recalculated: 2, failures: [] });
    await expect(
      runBalanceMaintenance(exec, { accountIds: ["acct-1", "acct-2"] })
    ).resolves.toEqual({ recalculated: 2, failures: [] });
    expect(mockTargeted).toHaveBeenCalledWith(exec, ["acct-1", "acct-2"]);
    expect(mockRecalc).not.toHaveBeenCalled();
  });

  it("collapses duplicate and malformed accountIds before targeting", async () => {
    mockTargeted.mockResolvedValue({ recalculated: 1, failures: [] });
    await runBalanceMaintenance(exec, { accountIds: ["acct-1", "acct-1", "", 42, null] });
    expect(mockTargeted).toHaveBeenCalledWith(exec, ["acct-1"]);
    expect(mockRecalc).not.toHaveBeenCalled();
  });

  it("falls back to the full rebuild for an empty or malformed accountIds", async () => {
    mockRecalc.mockResolvedValue({ recalculated: 5, failures: [] });
    await runBalanceMaintenance(exec, { accountIds: [] });
    await runBalanceMaintenance(exec, { accountIds: "acct-1" });
    expect(mockRecalc).toHaveBeenCalledTimes(2);
    expect(mockTargeted).not.toHaveBeenCalled();
  });

  it("throws for a targeted failure too, so targeted repair jobs retry", async () => {
    mockTargeted.mockResolvedValue({
      recalculated: 0,
      failures: [{ accountId: "acct-7", error: "transient database error" }]
    });
    await expect(runBalanceMaintenance(exec, { accountIds: ["acct-7"] })).rejects.toThrow(
      /failed for 1 account\(s\): acct-7/
    );
  });

  it("passes the payload through the registered handler to the targeted path", async () => {
    mockTargeted.mockResolvedValue({
      recalculated: 0,
      failures: [{ accountId: "acct-3", error: "boom" }]
    });
    const registry = await createJobRegistry();
    const handler = registry.get("maintenance:balances");
    expect(handler).toBeDefined();
    await expect(handler!({ accountIds: ["acct-3"] }, exec)).rejects.toThrow(/acct-3/);
    expect(mockTargeted).toHaveBeenCalledWith(exec, ["acct-3"]);
    expect(mockRecalc).not.toHaveBeenCalled();
  });
});
