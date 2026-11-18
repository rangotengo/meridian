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
import { GripVerticalIcon, LayoutGridIcon, LockIcon } from "lucide-react";
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

const STORAGE_KEY = "meridian-dashboard-order";
const nullStrategy = () => null;

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
        "relative transition-opacity duration-200",
        block.compact && "self-start",
        isDragging && "opacity-30",
        editing && !isDragging && "rounded-xl ring-2 ring-dashed ring-primary/20"
      )}
    >
      {editing ? (
        <div
          {...attributes}
          {...listeners}
          className="absolute -top-3 left-1/2 z-10 flex -translate-x-1/2 cursor-grab items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground shadow-md active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-3" />
          {block.label}
        </div>
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

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const order = JSON.parse(saved) as string[];
      const reordered = order
        .map((id) => defaultBlocks.find((block) => block.id === id))
        .filter((block): block is Block => Boolean(block));
      for (const block of defaultBlocks) {
        if (!reordered.find((item) => item.id === block.id)) reordered.push(block);
      }
      queueMicrotask(() => {
        setBlocks(reordered);
      });
    } catch {
      /* ignore */
    }
  }, []);
  const [, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    setBlocks((prev) => {
      const oldIndex = prev.findIndex((block) => block.id === active.id);
      const newIndex = prev.findIndex((block) => block.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map((block) => block.id)));
      return next;
    });
  };

  return (
    <DashboardDataProvider data={data}>
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{data.greeting}</h1>
            <p className="text-sm text-muted-foreground">{data.dateLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            {editing ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => {
                  setBlocks(defaultBlocks);
                  localStorage.removeItem(STORAGE_KEY);
                }}
              >
                Reset layout
              </Button>
            ) : null}
            <Button
              variant={editing ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? (
                <>
                  <LockIcon className="size-3" />
                  Lock
                </>
              ) : (
                <>
                  <LayoutGridIcon className="size-3" />
                  Customize
                </>
              )}
            </Button>
          </div>
        </div>

        <FxWarning />

        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={blocks.map((block) => block.id)} strategy={nullStrategy}>
            <div className="grid grid-cols-12 gap-4">
              {blocks.map((block) => (
                <SortableWidget key={block.id} block={block} editing={editing} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </DashboardDataProvider>
  );
}
