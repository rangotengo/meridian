import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  sync: vi.fn(),
  assertActor: vi.fn()
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ assertActor: mocks.assertActor }));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/security/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => undefined)
}));
vi.mock("@/server/domain/meroshare", () => ({
  connectMeroShare: mocks.connect,
  syncMeroShareConnection: mocks.sync,
  disconnectMeroShareConnection: vi.fn(async () => undefined),
  MeroShareClient: { capitals: vi.fn(async () => []) }
}));

import {
  connectMeroShareAction,
  syncMeroShareAction
} from "@/app/(app)/settings/meroshare/actions";

const COST_BASIS_WARNING =
  "Cost basis unavailable: MeroShare's WACC report could not be retrieved, so holdings were imported without purchase cost.";
const CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";

function connectForm(): FormData {
  const form = new FormData();
  form.set("clientId", "1");
  form.set("dpCode", "TEST");
  form.set("dpName", "Test Capital Ltd");
  form.set("username", "demat-user");
  form.set("password", "pw");
  return form;
}

function syncForm(): FormData {
  const form = new FormData();
  form.set("connectionId", CONNECTION_ID);
  return form;
}

describe("MeroShare settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertActor.mockResolvedValue({ userId: "user-1", familyId: "family-1" });
  });

  it("connect returns the partial-success result with warnings", async () => {
    mocks.connect.mockResolvedValue({
      connectionId: "connection-1",
      accounts: 1,
      costBasisAvailable: false,
      warnings: [COST_BASIS_WARNING]
    });

    const state = await connectMeroShareAction(undefined, connectForm());

    expect(state).toEqual({
      ok: true,
      data: { accounts: 1, costBasisAvailable: false, warnings: [COST_BASIS_WARNING] }
    });
  });

  it("connect returns costBasisAvailable on a full success", async () => {
    mocks.connect.mockResolvedValue({
      connectionId: "connection-1",
      accounts: 2,
      costBasisAvailable: true,
      warnings: []
    });

    const state = await connectMeroShareAction(undefined, connectForm());

    expect(state).toEqual({
      ok: true,
      data: { accounts: 2, costBasisAvailable: true, warnings: [] }
    });
  });

  it("sync returns the partial-success result instead of discarding it", async () => {
    mocks.sync.mockResolvedValue({
      accounts: 1,
      costBasisAvailable: false,
      warnings: [COST_BASIS_WARNING]
    });

    const state = await syncMeroShareAction(undefined, syncForm());

    expect(mocks.sync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
      CONNECTION_ID
    );
    expect(state).toEqual({
      ok: true,
      data: { accounts: 1, costBasisAvailable: false, warnings: [COST_BASIS_WARNING] }
    });
  });
});
