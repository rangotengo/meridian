import { describe, expect, it } from "vitest";
import {
  applyVisibleOrder,
  buildDashboardLayout,
  DEFAULT_DASHBOARD_BLOCKS,
  DEFAULT_HIDDEN_WIDGETS,
  hideWidget,
  moveWidget,
  resetDashboardLayout,
  serializeDashboardLayout,
  setWidgetCompact,
  setWidgetSize,
  showWidget,
  visibleBlocks
} from "@/lib/dashboard-layout";

const defaultIds = DEFAULT_DASHBOARD_BLOCKS.map((block) => block.id);

function normalized(blocks: { id: string; size: string; compact?: boolean }[]) {
  return blocks.map((block) => ({
    id: block.id,
    size: block.size,
    compact: block.compact ?? false
  }));
}

describe("buildDashboardLayout", () => {
  it("returns the default layout with the new widgets hidden", () => {
    const layout = buildDashboardLayout(null);
    expect(layout.blocks.map((block) => block.id)).toEqual(defaultIds);
    expect(layout.hidden).toEqual(DEFAULT_HIDDEN_WIDGETS);
  });

  it("migrates a v1 bare order array without losing the arrangement", () => {
    const layout = buildDashboardLayout(["goals", "financial-overview"]);
    expect(layout.blocks.slice(0, 2).map((block) => block.id)).toEqual([
      "goals",
      "financial-overview"
    ]);
    // Widgets missing from v1 are appended in default order.
    expect(layout.blocks).toHaveLength(DEFAULT_DASHBOARD_BLOCKS.length);
    expect(layout.hidden).toEqual(
      expect.arrayContaining(["monthly-snapshot", ...DEFAULT_HIDDEN_WIDGETS])
    );
  });

  it("migrates a v2 layout, hides newly added widgets, and drops unknown ids", () => {
    const layout = buildDashboardLayout({
      version: 2,
      order: ["goals", "nope", "financial-overview", "goals"],
      hidden: ["bills", "nope"],
      sizes: { goals: "full", "financial-overview": "md", nope: "sm" }
    });

    expect(layout.blocks.slice(0, 2).map((block) => block.id)).toEqual([
      "goals",
      "financial-overview"
    ]);
    expect(layout.blocks.find((block) => block.id === "goals")?.size).toBe("full");
    expect(layout.blocks.find((block) => block.id === "financial-overview")?.size).toBe("md");
    expect(layout.hidden).toEqual(
      expect.arrayContaining(["bills", "monthly-snapshot", ...DEFAULT_HIDDEN_WIDGETS])
    );
    expect(layout.hidden).not.toContain("nope");
    expect(layout.blocks).toHaveLength(DEFAULT_DASHBOARD_BLOCKS.length);
  });

  it("keeps optional widgets hidden when a v3 layout omits the hidden list", () => {
    const layout = buildDashboardLayout({
      version: 3,
      order: ["financial-overview"]
    });

    expect(layout.hidden).toEqual(expect.arrayContaining(DEFAULT_HIDDEN_WIDGETS));
    expect(visibleBlocks(layout).some((block) => DEFAULT_HIDDEN_WIDGETS.includes(block.id))).toBe(
      false
    );
  });

  it("honors the exact hidden set, sizes and compact flags in a v3 layout", () => {
    const layout = buildDashboardLayout({
      version: 3,
      order: ["quick-actions", "financial-overview"],
      hidden: ["spending-categories"],
      sizes: { "quick-actions": "md" },
      compact: { "quick-actions": false }
    });

    expect(layout.hidden).toEqual(["spending-categories"]);
    expect(layout.blocks.find((block) => block.id === "quick-actions")).toMatchObject({
      size: "md",
      compact: false
    });
  });

  it("round-trips through serialize without losing order, sizes or compact flags", () => {
    const layout = buildDashboardLayout(null);
    const rebuilt = buildDashboardLayout(serializeDashboardLayout(layout));

    expect(normalized(rebuilt.blocks)).toEqual(normalized(DEFAULT_DASHBOARD_BLOCKS));
    expect(rebuilt.hidden.sort()).toEqual([...DEFAULT_HIDDEN_WIDGETS].sort());
  });
});

describe("applyVisibleOrder", () => {
  it("reorders visible widgets while leaving hidden widgets in their slots", () => {
    const layout = buildDashboardLayout(null);
    const visible = visibleBlocks(layout);
    const reversed = [...visible].reverse().map((block) => block.id);
    const next = applyVisibleOrder(layout, reversed);

    expect(visibleBlocks(next).map((block) => block.id)).toEqual(reversed);
    layout.blocks.forEach((block, index) => {
      if (layout.hidden.includes(block.id)) expect(next.blocks[index]).toEqual(block);
    });
  });
});

describe("moveWidget", () => {
  it("moves a visible widget one slot and no-ops at the edges", () => {
    const layout = buildDashboardLayout(null);
    const visible = visibleBlocks(layout);
    const first = visible[0]!;

    expect(visibleBlocks(moveWidget(layout, first.id, 1))[1]?.id).toBe(first.id);
    expect(moveWidget(layout, first.id, -1)).toBe(layout);
    expect(moveWidget(layout, visible.at(-1)!.id, 1)).toBe(layout);
  });
});

describe("showWidget / hideWidget", () => {
  it("appends a newly shown widget to the end of the visible order", () => {
    const layout = buildDashboardLayout(null);
    const next = showWidget(layout, "quick-actions");

    expect(next.hidden).not.toContain("quick-actions");
    expect(visibleBlocks(next).at(-1)?.id).toBe("quick-actions");
  });

  it("hides a widget and is idempotent", () => {
    const layout = buildDashboardLayout(null);
    const next = hideWidget(layout, "bills");

    expect(next.hidden).toContain("bills");
    expect(visibleBlocks(next).some((block) => block.id === "bills")).toBe(false);
    expect(hideWidget(next, "bills")).toBe(next);
  });
});

describe("widget options", () => {
  it("updates width and compact height without mutating the old layout", () => {
    const layout = buildDashboardLayout(null);
    const resized = setWidgetSize(layout, "bills", "md");
    const fitted = setWidgetCompact(resized, "bills", true);

    expect(resized.blocks.find((block) => block.id === "bills")?.size).toBe("md");
    expect(layout.blocks.find((block) => block.id === "bills")?.size).toBe("sm");
    expect(fitted.blocks.find((block) => block.id === "bills")?.compact).toBe(true);
    expect(resized.blocks.find((block) => block.id === "bills")?.compact).toBeUndefined();
  });

  it("reset restores the defaults with fresh block objects", () => {
    const reset = resetDashboardLayout();

    expect(reset.blocks.map((block) => block.id)).toEqual(defaultIds);
    expect(reset.hidden).toEqual(DEFAULT_HIDDEN_WIDGETS);
    expect(reset.blocks[0]).not.toBe(DEFAULT_DASHBOARD_BLOCKS[0]);
  });
});
