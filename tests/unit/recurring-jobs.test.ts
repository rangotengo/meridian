import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "@/server/db/client";

vi.mock("@/server/domain/recurring", () => ({
  postDueSeries: vi.fn()
}));

import { postDueSeries } from "@/server/domain/recurring";
import { createJobRegistry, runRecurringPost } from "@/server/queue/jobs";

const mockPost = vi.mocked(postDueSeries);
const exec = {} as Executor;

beforeEach(() => {
  mockPost.mockReset();
});

describe("runRecurringPost", () => {
  it("resolves with the result when no series failed", async () => {
    mockPost.mockResolvedValue({ posted: 3, paused: 1, failed: 0 });
    await expect(runRecurringPost(exec)).resolves.toEqual({ posted: 3, paused: 1, failed: 0 });
  });

  it("throws when any series failed, so the queue retries instead of marking success", async () => {
    mockPost.mockResolvedValue({ posted: 2, paused: 0, failed: 1 });
    await expect(runRecurringPost(exec)).rejects.toThrow(/failed for 1 series/);
  });

  it("propagates failures through the registered recurring:post queue handler", async () => {
    mockPost.mockResolvedValue({ posted: 0, paused: 0, failed: 2 });
    const registry = await createJobRegistry();
    const handler = registry.get("recurring:post");
    expect(handler).toBeDefined();
    await expect(handler!({}, exec)).rejects.toThrow(/failed for 2 series/);
  });

  it("lets the registered handler succeed when posting fully succeeds", async () => {
    mockPost.mockResolvedValue({ posted: 1, paused: 0, failed: 0 });
    const registry = await createJobRegistry();
    const handler = registry.get("recurring:post");
    await expect(handler!({}, exec)).resolves.toBeUndefined();
  });
});
