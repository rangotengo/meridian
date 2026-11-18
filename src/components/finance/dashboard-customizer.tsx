"use client";

import { useEffect, useState } from "react";
import {
  DndContext,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable } from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  ArrowLeftRightIcon,
  CalendarClockIcon,
  ChartAreaIcon,
  GripVerticalIcon,
  HeartPulseIcon,
  LayoutGridIcon,
  PiggyBankIcon,
  ReceiptIcon,
  RotateCcwIcon,
  WalletIcon,
  ZapIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DashboardDataProvider, type DashboardData } from "@/components/finance/dashboard-data";
import { FinancialOverview } from "@/components/finance/financial-overview";
import { AccountCards } from "@/components/finance/account-cards";
import { QuickActions } from "@/components/finance/quick-actions";
import { SpendingLimit } from "@/components/finance/spending-limit";
import { MoneyMovement } from "@/components/finance/money-movement";
import { RecentTransactions } from "@/components/finance/recent-transactions";
import { HealthScore } from "@/components/finance/health-score";
import { GoalsWidget } from "@/components/finance/goals-widget";
import { BillsWidget } from "@/components/finance/bills-widget";
import { FxWarning } from "@/components/finance/fx-warning";

type WidgetSize = "sm" | "lg" | "full";

type Block = {
  id: string;
  label: string;
  size: WidgetSize;
  // Compact widgets take their natural height instead of stretching to
  // the grid row height. Used for widgets whose content is short, so a
  // tall row would otherwise leave a big mostly-empty card.
  compact?: boolean;
};

type WidgetMeta = {
  icon: React.ComponentType<{ className?: string }>;
  description: string;
};

const widgetMeta: Record<string, WidgetMeta> = {
  "financial-overview": {
    icon: ChartAreaIcon,
    description: "Net worth total, trend and breakdown."
  },
  "account-cards": { icon: WalletIcon, description: "Account cards and wallet balance." },
  "transfer-spending": {
    icon: ZapIcon,
    description: "Quick actions and monthly spending limit."
  },
  "money-movement": {
    icon: ArrowLeftRightIcon,
    description: "Money in, money out and monthly chart."
  },
  "health-score": { icon: HeartPulseIcon, description: "Health score and factor breakdown." },
  bills: { icon: CalendarClockIcon, description: "Upcoming bills and reminders." },
  goals: { icon: PiggyBankIcon, description: "Savings goals and progress." },
  "recent-transactions": { icon: ReceiptIcon, description: "Latest ledger entries." }
};

const fallbackMeta: WidgetMeta = {
  icon: LayoutGridIcon,
  description: ""
};

const defaultBlocks: Block[] = [
  { id: "financial-overview", label: "Net worth", size: "lg" },
  { id: "account-cards", label: "Accounts", size: "sm" },
  { id: "transfer-spending", label: "Actions & spending", size: "sm" },
  { id: "money-movement", label: "Money movement", size: "sm" },
  { id: "health-score", label: "Financial health", size: "sm", compact: true },
  { id: "bills", label: "Bills & reminders", size: "sm" },
  { id: "goals", label: "Goals", size: "sm", compact: true },
  { id: "recent-transactions", label: "Recent transactions", size: "full" }
];

const sizeClass: Record<WidgetSize, string> = {
  sm: "col-span-12 lg:col-span-4",
  lg: "col-span-12 lg:col-span-8",
  full: "col-span-12"
};

const sizeOptions: { value: WidgetSize; label: string }[] = [
  { value: "sm", label: "Small" },
  { value: "lg", label: "Medium" },
  { value: "full", label: "Large" }
];

const STORAGE_KEY = "meridian-dashboard-order";
const nullStrategy = () => null;

type SavedLayout = {
  version: 2;
  order: string[];
  hidden: string[];
  sizes: Partial<Record<string, WidgetSize>>;
};

function isWidgetSize(value: unknown): value is WidgetSize {
  return value === "sm" || value === "lg" || value === "full";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Rebuild the layout from a saved value. Accepts both the v2 object
 * ({ order, hidden, sizes }) and the v1 bare array of ids (order only:
 * everything visible, default sizes), so an existing saved order is
 * migrated without losing the user's arrangement. Unknown ids are dropped
 * and widgets missing from the saved value are appended in default order.
 */
function buildLayout(saved: unknown): { blocks: Block[]; hidden: string[] } {
  const byId = new Map(defaultBlocks.map((block) => [block.id, block]));
  let order: string[] = [];
  let hidden: string[] = [];
  const sizes = new Map<string, WidgetSize>();
  if (isStringArray(saved)) {
    order = saved;
  } else if (saved && typeof saved === "object") {
    const record = saved as Record<string, unknown>;
    if (isStringArray(record.order)) order = record.order;
    if (isStringArray(record.hidden)) hidden = record.hidden;
    if (record.sizes && typeof record.sizes === "object") {
      for (const [id, size] of Object.entries(record.sizes as Record<string, unknown>)) {
        if (isWidgetSize(size)) sizes.set(id, size);
      }
    }
  }
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const id of order) {
    const fallback = byId.get(id);
    if (!fallback || seen.has(id)) continue;
    seen.add(id);
    blocks.push({ ...fallback, size: sizes.get(id) ?? fallback.size });
  }
  for (const fallback of defaultBlocks) {
    if (!seen.has(fallback.id)) blocks.push({ ...fallback });
  }
  return { blocks, hidden: hidden.filter((id) => byId.has(id)) };
}

function persistLayout(blocks: Block[], hidden: string[]) {
  try {
    const sizes: Partial<Record<string, WidgetSize>> = {};
    for (const block of blocks) sizes[block.id] = block.size;
    const saved: SavedLayout = {
      version: 2,
      order: blocks.map((block) => block.id),
      hidden,
      sizes
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* ignore */
  }
}

function widgetFor(id: string) {
  switch (id) {
    case "financial-overview":
      return <FinancialOverview />;
    case "account-cards":
      return <AccountCards />;
    case "transfer-spending":
      return (
        // QuickActions keeps its natural height (shrink-0): forcing both
        // cards to flex-1 halves squeezes it below its content height, and
        // the Card's overflow-hidden then clips its buttons mid-row.
        // SpendingLimit flexes to fill whatever height the row leaves.
        <div className="flex h-full flex-col gap-4 [&>*:first-child]:shrink-0 [&>*:last-child]:flex-auto">
          <QuickActions />
          <SpendingLimit />
        </div>
      );
    case "money-movement":
      return <MoneyMovement />;
    case "goals":
      return <GoalsWidget />;
    case "bills":
      return <BillsWidget />;
    case "health-score":
      return <HealthScore />;
    case "recent-transactions":
      return <RecentTransactions />;
    default:
      return null;
  }
}

function SortableWidget({ block, editing }: { block: Block; editing: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: block.id,
    disabled: !editing
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        sizeClass[block.size],
        "relative transition-[opacity,box-shadow] duration-200",
        block.compact && "self-start",
        isDragging && "z-20 scale-[1.02] opacity-95 shadow-2xl ring-2 ring-primary/40",
        editing && !isDragging && "rounded-xl ring-2 ring-dashed ring-primary/20"
      )}
    >
      {editing ? (
        <>
          <div className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-primary px-2.5 py-1 text-[10px] font-medium whitespace-nowrap text-primary-foreground shadow-md">
            {block.label}
          </div>
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${block.label} to reorder`}
            className="absolute -top-3 left-3 z-10 flex size-6 cursor-grab items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        </>
      ) : null}
      <div
        className={cn(
          !block.compact && "h-full [&>*]:h-full",
          editing && "pointer-events-none select-none"
        )}
      >
        {widgetFor(block.id)}
      </div>
    </div>
  );
}

export function DashboardCustomizer({ data }: { data: DashboardData }) {
  const [editing, setEditing] = useState(false);
  const [blocks, setBlocks] = useState(defaultBlocks);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const next = buildLayout(JSON.parse(raw));
      queueMicrotask(() => {
        setBlocks(next.blocks);
        setHiddenIds(next.hidden);
      });
    } catch {
      /* ignore */
    }
  }, []);
  const [, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const visibleBlocks = blocks.filter((block) => !hiddenIds.includes(block.id));

  function updateLayout(nextBlocks: Block[], nextHidden: string[]) {
    setBlocks(nextBlocks);
    setHiddenIds(nextHidden);
    persistLayout(nextBlocks, nextHidden);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visibleBlocks.findIndex((block) => block.id === active.id);
    const newIndex = visibleBlocks.findIndex((block) => block.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const nextVisible = arrayMove(visibleBlocks, oldIndex, newIndex);
    // Hidden widgets keep their slots in the full order; visible ones take
    // the new order, so re-showing a widget returns it to its old position.
    let visibleCursor = 0;
    const next = blocks.map((block) => {
      if (hiddenIds.includes(block.id)) return block;
      const replacement = nextVisible[visibleCursor];
      visibleCursor += 1;
      return replacement ?? block;
    });
    updateLayout(next, hiddenIds);
  }

  function setWidgetVisible(id: string, show: boolean) {
    const nextHidden = show ? hiddenIds.filter((hiddenId) => hiddenId !== id) : [...hiddenIds, id];
    updateLayout(blocks, nextHidden);
  }

  function setWidgetSize(id: string, size: WidgetSize) {
    updateLayout(
      blocks.map((block) => (block.id === id ? { ...block, size } : block)),
      hiddenIds
    );
  }

  function resetLayout() {
    updateLayout(defaultBlocks, []);
  }

  return (
    <DashboardDataProvider data={data}>
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{data.greeting}</h1>
            <p className="text-sm text-muted-foreground">{data.dateLabel}</p>
          </div>
          <Button
            variant={editing ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setEditing(true)}
          >
            <LayoutGridIcon className="size-3" />
            Customize
          </Button>
        </div>

        <FxWarning />

        {editing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-xs">
            <LayoutGridIcon className="size-3.5 shrink-0 text-primary" />
            <span className="font-medium">Editing layout</span>
            <span className="text-muted-foreground">
              Drag widgets by their handle to reorder. Use the panel to show, hide, or resize
              widgets.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 text-xs"
              onClick={() => setEditing(false)}
            >
              Done
            </Button>
          </div>
        ) : null}

        <Sheet
          open={editing}
          onOpenChange={(open, eventDetails) => {
            // The grid is the workspace while the panel is open: dragging a
            // widget fires outside-press and focus-out, and clicking the grid
            // fires outside-press; none of those may dismiss the panel. Only
            // explicit dismissal (the X, Escape, or a Done button) exits
            // edit mode.
            if (
              !open &&
              (eventDetails.reason === "outside-press" || eventDetails.reason === "focus-out")
            )
              return;
            if (!open) setEditing(false);
          }}
          modal={false}
        >
          <SheetContent side="right" showOverlay={false} className="sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Customize dashboard</SheetTitle>
              <SheetDescription>
                Show, hide, resize, and reorder widgets. Drag widgets on the dashboard to move them.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
              {blocks.map((block) => {
                const meta = widgetMeta[block.id] ?? fallbackMeta;
                const Icon = meta.icon;
                const visible = !hiddenIds.includes(block.id);
                return (
                  <div key={block.id} className="rounded-xl border p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                        <Icon className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{block.label}</p>
                        <p className="text-xs text-muted-foreground">{meta.description}</p>
                      </div>
                      <Switch
                        checked={visible}
                        onCheckedChange={(checked) => setWidgetVisible(block.id, checked)}
                        aria-label={`Show ${block.label}`}
                      />
                    </div>
                    <div
                      className="mt-3 flex gap-1 rounded-lg bg-muted p-1"
                      role="group"
                      aria-label={`${block.label} size`}
                    >
                      {sizeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          disabled={!visible}
                          aria-pressed={block.size === option.value}
                          onClick={() => setWidgetSize(block.id, option.value)}
                          className={cn(
                            "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                            block.size === option.value
                              ? "bg-card text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                            !visible && "opacity-50"
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <SheetFooter className="flex-row items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-muted-foreground"
                onClick={resetLayout}
              >
                <RotateCcwIcon className="size-3.5" />
                Reset layout
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                Done
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={visibleBlocks.map((block) => block.id)} strategy={nullStrategy}>
            <div className="grid grid-cols-12 gap-4">
              {visibleBlocks.map((block) => (
                <SortableWidget key={block.id} block={block} editing={editing} />
              ))}
              {visibleBlocks.length === 0 ? (
                <div className="col-span-12 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16 text-center">
                  <LayoutGridIcon className="size-8 text-muted-foreground" />
                  <p className="text-sm font-medium">All widgets are hidden</p>
                  <p className="text-xs text-muted-foreground">
                    Show widgets from the customize panel to build your dashboard.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => setEditing(true)}>
                      Customize dashboard
                    </Button>
                    <Button size="sm" variant="outline" onClick={resetLayout}>
                      Reset layout
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </DashboardDataProvider>
  );
}
