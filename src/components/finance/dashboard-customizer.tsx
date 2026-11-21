"use client";

import { useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowUpIcon,
  CalendarClockIcon,
  ChartAreaIcon,
  ChartPieIcon,
  CheckIcon,
  EyeOffIcon,
  GripVerticalIcon,
  HeartPulseIcon,
  LayoutGridIcon,
  MousePointerClickIcon,
  PiggyBankIcon,
  PlusIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TrendingUpIcon,
  WalletIcon,
  ZapIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  applyVisibleOrder,
  buildDashboardLayout,
  DASHBOARD_LAYOUT_STORAGE_KEY,
  DASHBOARD_SIZE_OPTIONS,
  DEFAULT_DASHBOARD_BLOCKS,
  DEFAULT_HIDDEN_WIDGETS,
  hideWidget,
  moveWidget,
  resetDashboardLayout,
  serializeDashboardLayout,
  setWidgetCompact,
  setWidgetSize,
  showWidget,
  visibleBlocks,
  type DashboardBlock,
  type DashboardLayout,
  type WidgetSize
} from "@/lib/dashboard-layout";
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
import { MonthlySnapshot } from "@/components/finance/monthly-snapshot";
import { SpendingBreakdown } from "@/components/finance/spending-breakdown";
import { FxWarning } from "@/components/finance/fx-warning";

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
    description: "Quick actions and monthly spending limit together."
  },
  "money-movement": {
    icon: ArrowLeftRightIcon,
    description: "Money in, money out and monthly chart."
  },
  "health-score": { icon: HeartPulseIcon, description: "Health score and factor breakdown." },
  bills: { icon: CalendarClockIcon, description: "Upcoming bills and reminders." },
  goals: { icon: PiggyBankIcon, description: "Savings goals and progress." },
  "recent-transactions": { icon: ReceiptIcon, description: "Latest ledger entries." },
  "monthly-snapshot": {
    icon: TrendingUpIcon,
    description: "Income, spending, net saved and savings rate this month."
  },
  "spending-categories": {
    icon: ChartPieIcon,
    description: "Where this month's spending went."
  },
  "quick-actions": {
    icon: MousePointerClickIcon,
    description: "Quick add, ledger entry and account shortcuts on their own."
  },
  "spending-limit": {
    icon: ShieldCheckIcon,
    description: "Overall monthly budget and remaining spend on its own."
  }
};

const fallbackMeta: WidgetMeta = {
  icon: LayoutGridIcon,
  description: ""
};

const sizeClass: Record<WidgetSize, string> = {
  sm: "col-span-12 lg:col-span-4",
  md: "col-span-12 lg:col-span-6",
  lg: "col-span-12 lg:col-span-8",
  full: "col-span-12"
};

const labelById = new Map(DEFAULT_DASHBOARD_BLOCKS.map((block) => [block.id, block.label]));

function labelFor(id: UniqueIdentifier) {
  return labelById.get(String(id)) ?? String(id);
}

const announcements: Announcements = {
  onDragStart({ active }) {
    return `Picked up ${labelFor(active.id)}.`;
  },
  onDragOver({ active, over }) {
    if (!over) return `${labelFor(active.id)} is not over a widget.`;
    return `${labelFor(active.id)} is over ${labelFor(over.id)}.`;
  },
  onDragEnd({ active, over }) {
    if (!over) return `${labelFor(active.id)} was dropped.`;
    return `${labelFor(active.id)} was dropped over ${labelFor(over.id)}.`;
  },
  onDragCancel({ active }) {
    return `Moving ${labelFor(active.id)} was cancelled.`;
  }
};

// Pointer-first so a drag only targets a widget the pointer is actually
// over; closestCenter keeps keyboard and edge drags working when the
// pointer sits in a grid gap.
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

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
    case "monthly-snapshot":
      return <MonthlySnapshot />;
    case "spending-categories":
      return <SpendingBreakdown />;
    case "quick-actions":
      return <QuickActions />;
    case "spending-limit":
      return <SpendingLimit />;
    default:
      return null;
  }
}

function SortableWidget({
  block,
  editing,
  position,
  total
}: {
  block: DashboardBlock;
  editing: boolean;
  position: number;
  total: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    disabled: !editing
  });
  const meta = widgetMeta[block.id] ?? fallbackMeta;
  const Icon = meta.icon;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        sizeClass[block.size],
        "relative",
        block.compact && "self-start",
        editing &&
          "rounded-xl ring-2 ring-primary/20 hover:ring-primary/40 focus-within:ring-primary/50",
        isDragging && "z-20 opacity-30"
      )}
    >
      {editing ? (
        <div
          {...attributes}
          {...listeners}
          aria-label={`Move ${block.label}`}
          className="absolute inset-x-0 top-0 z-10 flex h-9 cursor-grab touch-none items-center gap-2 rounded-t-xl border-b border-primary/20 bg-primary/10 px-3 text-xs font-medium text-primary backdrop-blur-sm select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-3.5 shrink-0" />
          <Icon className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{block.label}</span>
          <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] tabular-nums">
            {position + 1}/{total}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          !block.compact && "h-full [&>*]:h-full",
          // Reserve the drag bar's height so it never covers the card header.
          editing && "pt-9 pointer-events-none select-none"
        )}
      >
        {widgetFor(block.id)}
      </div>
      {editing ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-primary/10 ring-inset"
        />
      ) : null}
    </div>
  );
}

function DragPreview({ block }: { block: DashboardBlock }) {
  const meta = widgetMeta[block.id] ?? fallbackMeta;
  const Icon = meta.icon;
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] rotate-1 rounded-xl border-2 border-primary/40 bg-card p-3 shadow-2xl ring-1 ring-primary/20">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{block.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{meta.description}</p>
        </div>
        <GripVerticalIcon className="size-4 shrink-0 text-muted-foreground" />
      </div>
    </div>
  );
}

function WidgetSettingsRow({
  block,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onHide,
  onSize,
  onCompact
}: {
  block: DashboardBlock;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onHide: () => void;
  onSize: (size: WidgetSize) => void;
  onCompact: (compact: boolean) => void;
}) {
  const meta = widgetMeta[block.id] ?? fallbackMeta;
  const Icon = meta.icon;

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{block.label}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{meta.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={index === 0}
            onClick={onMoveUp}
            aria-label={`Move ${block.label} up`}
            title="Move up"
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={index === total - 1}
            onClick={onMoveDown}
            aria-label={`Move ${block.label} down`}
            title="Move down"
          >
            <ArrowDownIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onHide}
            aria-label={`Hide ${block.label}`}
            title="Hide widget"
          >
            <EyeOffIcon />
          </Button>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <div
          className="flex flex-1 gap-0.5 rounded-lg bg-muted p-0.5"
          role="group"
          aria-label={`${block.label} width`}
        >
          {DASHBOARD_SIZE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={block.size === option.value}
              title={option.title}
              onClick={() => onSize(option.value)}
              className={cn(
                "flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                block.size === option.value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label
          htmlFor={`widget-fit-${block.id}`}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
          title="Use the widget's natural height instead of stretching it"
        >
          <Switch
            id={`widget-fit-${block.id}`}
            size="sm"
            checked={block.compact ?? false}
            onCheckedChange={onCompact}
            aria-label={`Fit ${block.label} to content`}
          />
          Fit
        </label>
      </div>
    </div>
  );
}

function AvailableWidgetRow({ block, onAdd }: { block: DashboardBlock; onAdd: () => void }) {
  const meta = widgetMeta[block.id] ?? fallbackMeta;
  const Icon = meta.icon;

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-dashed p-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{block.label}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{meta.description}</p>
      </div>
      <Button
        size="xs"
        variant="outline"
        className="shrink-0 gap-1"
        onClick={onAdd}
        aria-label={`Add ${block.label}`}
      >
        <PlusIcon />
        Add
      </Button>
    </div>
  );
}

export function DashboardCustomizer({ data }: { data: DashboardData }) {
  const [editing, setEditing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [layout, setLayout] = useState<DashboardLayout>(() => ({
    blocks: DEFAULT_DASHBOARD_BLOCKS,
    hidden: DEFAULT_HIDDEN_WIDGETS
  }));
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const next = buildDashboardLayout(JSON.parse(raw));
      queueMicrotask(() => setLayout(next));
    } catch {
      /* ignore */
    }
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const visible = useMemo(() => visibleBlocks(layout), [layout]);
  const hidden = useMemo(
    () => layout.blocks.filter((block) => layout.hidden.includes(block.id)),
    [layout]
  );
  const activeBlock = activeId
    ? (layout.blocks.find((block) => block.id === activeId) ?? null)
    : null;

  function updateLayout(next: DashboardLayout) {
    setLayout(next);
    try {
      localStorage.setItem(
        DASHBOARD_LAYOUT_STORAGE_KEY,
        JSON.stringify(serializeDashboardLayout(next))
      );
    } catch {
      /* ignore */
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = visible.map((block) => block.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    updateLayout(applyVisibleOrder(layout, arrayMove(ids, oldIndex, newIndex)));
  }

  function handleMove(id: string, direction: -1 | 1) {
    updateLayout(moveWidget(layout, id, direction));
  }

  function handleHide(id: string) {
    updateLayout(hideWidget(layout, id));
  }

  function handleShow(id: string) {
    updateLayout(showWidget(layout, id));
  }

  function handleSize(id: string, size: WidgetSize) {
    updateLayout(setWidgetSize(layout, id, size));
  }

  function handleCompact(id: string, compact: boolean) {
    updateLayout(setWidgetCompact(layout, id, compact));
  }

  function handleReset() {
    updateLayout(resetDashboardLayout());
  }

  function startEditing() {
    setEditing(true);
    setPanelOpen(true);
  }

  function stopEditing() {
    setEditing(false);
    setPanelOpen(false);
  }

  return (
    <DashboardDataProvider data={data}>
      <div
        className={cn(
          "flex flex-1 flex-col gap-4",
          // Keep the full grid visible next to the options panel on wide
          // screens instead of letting the panel cover the right column.
          editing && panelOpen && "xl:pr-[24rem]"
        )}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{data.greeting}</h1>
            <p className="text-sm text-muted-foreground">{data.dateLabel}</p>
          </div>
          <Button
            variant={editing ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => (editing ? stopEditing() : startEditing())}
          >
            {editing ? <CheckIcon className="size-3" /> : <LayoutGridIcon className="size-3" />}
            {editing ? "Done" : "Customize"}
          </Button>
        </div>

        <FxWarning />

        {editing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-xs">
            <GripVerticalIcon className="size-3.5 shrink-0 text-primary" />
            <span className="font-medium">Edit layout</span>
            <span className="text-muted-foreground">
              Drag any card by its top bar to move it. Use the panel for width, fit, and visibility.
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {!panelOpen ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setPanelOpen(true)}
                >
                  <SlidersHorizontalIcon className="size-3.5" />
                  Widget options
                </Button>
              ) : null}
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={stopEditing}>
                Done
              </Button>
            </div>
          </div>
        ) : null}

        <Sheet
          open={panelOpen}
          onOpenChange={(open, eventDetails) => {
            // The grid is the workspace while the panel is open: dragging a
            // widget fires outside-press and focus-out, and clicking the grid
            // fires outside-press; none of those may dismiss the panel.
            // Closing the panel (X or Escape) keeps edit mode so the whole
            // grid stays draggable; the header/banner "Done" exits.
            if (
              !open &&
              (eventDetails.reason === "outside-press" || eventDetails.reason === "focus-out")
            )
              return;
            if (!open) setPanelOpen(false);
          }}
          modal={false}
        >
          <SheetContent side="right" showOverlay={false} className="sm:max-w-md">
            <SheetHeader className="border-b">
              <div className="flex items-start justify-between gap-3 pr-8">
                <div className="space-y-0.5">
                  <SheetTitle>Customize dashboard</SheetTitle>
                  <SheetDescription>
                    Drag a card&apos;s top bar to move it, or use the arrows here. Changes save
                    automatically.
                  </SheetDescription>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                  {visible.length}/{layout.blocks.length}
                </span>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    On your dashboard
                  </h3>
                  <span className="text-[11px] text-muted-foreground">Top to bottom</span>
                </div>
                {visible.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                    No widgets are showing. Add one from the available list below.
                  </p>
                ) : null}
                {visible.map((block, index) => (
                  <WidgetSettingsRow
                    key={block.id}
                    block={block}
                    index={index}
                    total={visible.length}
                    onMoveUp={() => handleMove(block.id, -1)}
                    onMoveDown={() => handleMove(block.id, 1)}
                    onHide={() => handleHide(block.id)}
                    onSize={(size) => handleSize(block.id, size)}
                    onCompact={(compact) => handleCompact(block.id, compact)}
                  />
                ))}
              </section>

              {hidden.length > 0 ? (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Available widgets
                    </h3>
                    <span className="text-[11px] text-muted-foreground">{hidden.length}</span>
                  </div>
                  {hidden.map((block) => (
                    <AvailableWidgetRow
                      key={block.id}
                      block={block}
                      onAdd={() => handleShow(block.id)}
                    />
                  ))}
                </section>
              ) : null}
            </div>

            <SheetFooter className="border-t">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <CheckIcon className="size-3" />
                  Saved automatically
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-xs text-muted-foreground"
                    onClick={handleReset}
                    title="Restore the default dashboard"
                  >
                    <RotateCcwIcon className="size-3.5" />
                    Reset
                  </Button>
                  <Button size="sm" onClick={stopEditing}>
                    Done
                  </Button>
                </div>
              </div>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          accessibility={{ announcements }}
          onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={visible.map((block) => block.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-12 gap-4">
              {visible.map((block, index) => (
                <SortableWidget
                  key={block.id}
                  block={block}
                  editing={editing}
                  position={index}
                  total={visible.length}
                />
              ))}
              {visible.length === 0 ? (
                <div className="col-span-12 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16 text-center">
                  <LayoutGridIcon className="size-8 text-muted-foreground" />
                  <p className="text-sm font-medium">All widgets are hidden</p>
                  <p className="text-xs text-muted-foreground">
                    Show widgets from the customize panel to build your dashboard.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={startEditing}>
                      Customize dashboard
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleReset}>
                      Reset layout
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
            {activeBlock ? <DragPreview block={activeBlock} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </DashboardDataProvider>
  );
}
