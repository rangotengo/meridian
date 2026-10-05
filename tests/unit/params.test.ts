import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCloudParams() {
  vi.resetModules();
  vi.stubEnv("DATABASE_BACKEND", "cloud-sqlite");
  return import("@/server/db/params");
}

describe("cloud SQLite parameter chunking", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps multi-row inserts within 100 bound parameters", async () => {
    const { chunkRows } = await loadCloudParams();
    const chunks = chunkRows(
      Array.from({ length: 501 }, (_, i) => i),
      4
    );
    expect(Math.max(...chunks.map((c) => c.length * 4))).toBeLessThanOrEqual(100);
    expect(chunks.flat()).toHaveLength(501);
  });

  it("leaves headroom in IN lists for the statement's other filters", async () => {
    const { chunkParams } = await loadCloudParams();
    const chunks = chunkParams(Array.from({ length: 250 }, (_, i) => `id-${i}`));
    // e.g. family_id + status + the IN list must still fit in one statement
    expect(Math.max(...chunks.map((c) => c.length + 2))).toBeLessThanOrEqual(100);
    expect(chunks.flat()).toHaveLength(250);
  });
});
