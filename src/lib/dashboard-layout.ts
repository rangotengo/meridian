/**
 * Pure layout logic for the customizable dashboard.
 *
 * The dashboard stores a single localStorage value: the order of every
 * widget (hidden ones included), which ones are hidden, and each widget's
 * width/height preferences. Keeping the parsing and reordering rules here
 * makes them testable without a browser or React.
 */

export type WidgetSize = "sm" | "md" | "lg" | "full";

export type DashboardBlock = {
  id: string;
  label: string;
  size: WidgetSize;
  // Compact widgets take their natural height instead of stretching to
  // the grid row height. Used for widgets whose content is short, so a
  // tall row would otherwise leave a big mostly-empty card.
  compact?: boolean;
};

export type DashboardLayout = {
  /** Every widget in order, including hidden ones. */
  blocks: DashboardBlock[];
  /** Widget ids currently hidden from the grid. */
  hidden: string[];
};

export type SavedDashboardLayout = {
  version: 3;
  order: string[];
  hidden: string[];
  sizes: Partial<Record<string, WidgetSize>>;
  compact: Partial<Record<string, boolean>>;
};

export const DASHBOARD_LAYOUT_STORAGE_KEY = "meridian-dashboard-order";
export const DASHBOARD_LAYOUT_VERSION = 3;

export const DASHBOARD_SIZE_OPTIONS: { value: WidgetSize; label: string; title: string }[] = [
  { value: "sm", label: "1/3", title: "Small — one third of the row" },
  { value: "md", label: "1/2", title: "Medium — half of the row" },
  { value: "lg", label: "2/3", title: "Large — two thirds of the row" },
  { value: "full", label: "Full", title: "Full width" }
];

export const DEFAULT_DASHBOARD_BLOCKS: DashboardBlock[] = [
  { id: "financial-overview", label: "Net worth", size: "lg" },
  { id: "account-cards", label: "Accounts", size: "sm" },
  { id: "transfer-spending", label: "Actions & spending", size: "sm" },
  { id: "money-movement", label: "Money movement", size: "sm" },
  { id: "health-score", label: "Financial health", size: "sm", compact: true },
  { id: "bills", label: "Bills & reminders", size: "sm" },
  { id: "goals", label: "Goals", size: "sm", compact: true },
  { id: "monthly-snapshot", label: "Monthly snapshot", size: "sm", compact: true },
  { id: "recent-transactions", label: "Recent transactions", size: "full" },
  { id: "spending-categories", label: "Spending by category", size: "lg" },
  { id: "quick-actions", label: "Quick actions", size: "sm", compact: true },
  { id: "spending-limit", label: "Spending limit", size: "sm" }
];

/**
 * Widgets that start in the "Available widgets" list on a fresh dashboard.
 * Existing saved layouts (v1/v2) get them hidden too, so a new widget never
 * appears on someone's dashboard uninvited.
 */
export const DEFAULT_HIDDEN_WIDGETS = ["spending-categories", "quick-actions", "spending-limit"];

/**
 * Widgets added in v3 that should not be forced onto an existing saved
 * layout. `monthly-snapshot` is visible for a fresh dashboard (where it
 * completes the third row), but migrated layouts keep it available rather
 * than appending a lone card under recent transactions.
 */
const MIGRATION_HIDDEN_WIDGETS = ["monthly-snapshot", ...DEFAULT_HIDDEN_WIDGETS];

function isWidgetSize(value: unknown): value is WidgetSize {
  return value === "sm" || value === "md" || value === "lg" || value === "full";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Rebuild the layout from a saved value. Accepts the v3 object
 * ({ version, order, hidden, sizes, compact }), the v2 object
 * ({ order, hidden, sizes }) and the v1 bare array of ids (order only).
 * Unknown ids are dropped and widgets missing from the saved value are
 * appended in default order.
 */
export function buildDashboardLayout(saved: unknown): DashboardLayout {
  const byId = new Map(DEFAULT_DASHBOARD_BLOCKS.map((block) => [block.id, block]));
  let order: string[] = [];
  let rawHidden: string[] = [];
  // No saved value means a fresh dashboard, not an old layout.
  let version = DASHBOARD_LAYOUT_VERSION;
  const sizes = new Map<string, WidgetSize>();
  const compact = new Map<string, boolean>();

  if (saved == null) {
    rawHidden = [...DEFAULT_HIDDEN_WIDGETS];
  } else if (isStringArray(saved)) {
    order = saved;
    version = 1;
  } else if (saved && typeof saved === "object") {
    const record = saved as Record<string, unknown>;
    version = typeof record.version === "number" ? record.version : 2;
    if (isStringArray(record.order)) order = record.order;
    if (isStringArray(record.hidden)) {
      rawHidden = record.hidden;
    } else if (version >= DASHBOARD_LAYOUT_VERSION) {
      // A current layout that omits `hidden` still starts from the default
      // available set, so optional widgets are not forced onto the grid.
      rawHidden = [...DEFAULT_HIDDEN_WIDGETS];
    }
    if (record.sizes && typeof record.sizes === "object") {
      for (const [id, size] of Object.entries(record.sizes as Record<string, unknown>)) {
        if (isWidgetSize(size)) sizes.set(id, size);
      }
    }
    if (record.compact && typeof record.compact === "object") {
      for (const [id, value] of Object.entries(record.compact as Record<string, unknown>)) {
        if (typeof value === "boolean") compact.set(id, value);
      }
    }
  }

  const seen = new Set<string>();
  const blocks: DashboardBlock[] = [];
  for (const id of order) {
    const fallback = byId.get(id);
    if (!fallback || seen.has(id)) continue;
    seen.add(id);
    blocks.push({
      ...fallback,
      size: sizes.get(id) ?? fallback.size,
      compact: compact.get(id) ?? fallback.compact
    });
  }
  for (const fallback of DEFAULT_DASHBOARD_BLOCKS) {
    if (seen.has(fallback.id)) continue;
    blocks.push({
      ...fallback,
      size: sizes.get(fallback.id) ?? fallback.size,
      compact: compact.get(fallback.id) ?? fallback.compact
    });
  }

  const hidden = new Set(rawHidden.filter((id) => byId.has(id)));
  if (version < DASHBOARD_LAYOUT_VERSION) {
    for (const id of MIGRATION_HIDDEN_WIDGETS) hidden.add(id);
  }

  return { blocks, hidden: Array.from(hidden) };
}

export function serializeDashboardLayout(layout: DashboardLayout): SavedDashboardLayout {
  const sizes: Partial<Record<string, WidgetSize>> = {};
  const compact: Partial<Record<string, boolean>> = {};
  for (const block of layout.blocks) {
    sizes[block.id] = block.size;
    compact[block.id] = block.compact ?? false;
  }
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    order: layout.blocks.map((block) => block.id),
    hidden: layout.hidden,
    sizes,
    compact
  };
}

/** The visible widgets in their current order. */
export function visibleBlocks(layout: DashboardLayout): DashboardBlock[] {
  const hidden = new Set(layout.hidden);
  return layout.blocks.filter((block) => !hidden.has(block.id));
}

/**
 * Apply a new visible order without disturbing hidden widgets' slots in
 * the full order. Passing the same number of ids as visible widgets keeps
 * every widget present.
 */
export function applyVisibleOrder(
  layout: DashboardLayout,
  orderedVisibleIds: string[]
): DashboardLayout {
  const hidden = new Set(layout.hidden);
  const byId = new Map(layout.blocks.map((block) => [block.id, block]));
  let cursor = 0;
  const blocks = layout.blocks.map((block) => {
    if (hidden.has(block.id)) return block;
    const nextId = orderedVisibleIds[cursor];
    cursor += 1;
    return (nextId && byId.get(nextId)) || block;
  });
  return { blocks, hidden: layout.hidden };
}

/** Move one visible widget up (-1) or down (+1). */
export function moveWidget(
  layout: DashboardLayout,
  id: string,
  direction: -1 | 1
): DashboardLayout {
  const visible = visibleBlocks(layout);
  const index = visible.findIndex((block) => block.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= visible.length) return layout;
  const next = [...visible];
  const [moved] = next.splice(index, 1);
  if (!moved) return layout;
  next.splice(target, 0, moved);
  return applyVisibleOrder(
    layout,
    next.map((block) => block.id)
  );
}

/**
 * Show a hidden widget at the end of the visible order. New widgets
 * should appear where the user is looking (the bottom of the grid), not
 * back at some stale slot from before they were hidden.
 */
export function showWidget(layout: DashboardLayout, id: string): DashboardLayout {
  if (!layout.hidden.includes(id)) return layout;
  const block = layout.blocks.find((item) => item.id === id);
  if (!block) return layout;

  const hidden = layout.hidden.filter((hiddenId) => hiddenId !== id);
  const without = layout.blocks.filter((item) => item.id !== id);
  const hiddenSet = new Set(hidden);
  let insertAt = 0;
  without.forEach((item, index) => {
    if (!hiddenSet.has(item.id)) insertAt = index + 1;
  });
  const blocks = [...without.slice(0, insertAt), block, ...without.slice(insertAt)];
  return { blocks, hidden };
}

export function hideWidget(layout: DashboardLayout, id: string): DashboardLayout {
  if (layout.hidden.includes(id)) return layout;
  if (!layout.blocks.some((block) => block.id === id)) return layout;
  return { ...layout, hidden: [...layout.hidden, id] };
}

export function setWidgetSize(
  layout: DashboardLayout,
  id: string,
  size: WidgetSize
): DashboardLayout {
  return {
    ...layout,
    blocks: layout.blocks.map((block) => (block.id === id ? { ...block, size } : block))
  };
}

export function setWidgetCompact(
  layout: DashboardLayout,
  id: string,
  compact: boolean
): DashboardLayout {
  return {
    ...layout,
    blocks: layout.blocks.map((block) => (block.id === id ? { ...block, compact } : block))
  };
}

export function resetDashboardLayout(): DashboardLayout {
  return {
    blocks: DEFAULT_DASHBOARD_BLOCKS.map((block) => ({ ...block })),
    hidden: [...DEFAULT_HIDDEN_WIDGETS]
  };
}
