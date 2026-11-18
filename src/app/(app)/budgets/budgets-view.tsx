"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import { setBudgetAction, setBudgetRolloverAction, removeBudgetAction } from "./actions";
import { Card, Badge } from "@/components/ds/card";
import { SetupPanel } from "@/components/ds/setup-panel";
import { Field, FormError, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { BudgetRings } from "@/components/finance/budget-rings";
import { fmtMoney } from "@/lib/format";
import { minorToDecimal } from "@/lib/money";
import { usePrivacy } from "@/components/layout/privacy-context";
import type { BudgetProgress, BudgetSummary, BudgetAlert } from "@/server/domain/budgets";

function pctTone(pct: number): "success" | "warning" | "destructive" {
  if (pct >= 1) return "destructive";
  if (pct >= 0.8) return "warning";
  return "success";
}

/** Worded alert shown next to the percentage once a budget is at risk. */
function alertLabel(alert: BudgetAlert): string | null {
  if (alert === "over") return "Over budget";
  if (alert === "warning") return "Approaching limit";
  return null;
}

function AlertBadge({ alert, pct }: { alert: BudgetAlert; pct: number }) {
  const label = alertLabel(alert);
  return (
    <>
      <Badge tone={pctTone(pct)}>{Math.round(pct * 100)}% used</Badge>
      {label ? <Badge tone={pctTone(pct)}>{label}</Badge> : null}
    </>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.min(pct, 1.5);
  const width = Math.min(clamped / 1.5, 1) * 100;
  const tone = pctTone(pct);
  const color =
    tone === "destructive" ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-success";
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-border/60"
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={150}
    >
      <div className={`h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * Per-budget rollover toggle. Switching off removes the rolled-over amount
 * for the current month immediately; last month's unspent is not banked.
 */
function RolloverToggle({
  categoryId,
  rollover
}: {
  categoryId: string | null;
  rollover: boolean;
}) {
  const [state, action] = useActionState(setBudgetRolloverAction, undefined);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="categoryId" value={categoryId ?? ""} />
      <input type="hidden" name="rollover" value={rollover ? "off" : "on"} />
      <SubmitButton variant="ghost" className="px-2 py-1 text-xs">
        Rollover unspent: {rollover ? "On" : "Off"}
      </SubmitButton>
      <FormError message={state?.ok === false ? state.error : undefined} />
    </form>
  );
}

export function BudgetsView({
  currency,
  overall,
  perCategory,
  summary,
  categoriesWithoutBudget,
  monthLabel,
  privacy = false
}: {
  currency: string;
  overall: BudgetProgress | null;
  perCategory: BudgetProgress[];
  summary: BudgetSummary;
  categoriesWithoutBudget: { id: string; name: string }[];
  monthLabel: string;
  privacy?: boolean;
}) {
  const contextPrivacy = usePrivacy();
  const effectivePrivacy = privacy || contextPrivacy;
  const fmt = (minor: number) => (effectivePrivacy ? "•••••" : fmtMoney(minor, currency));

  const rings = [
    ...(overall
      ? [
          {
            id: "overall",
            name: "Overall",
            spentMinor: overall.spentMinor,
            limitMinor: overall.effectiveLimitMinor,
            pct: overall.pct
          }
        ]
      : []),
    ...perCategory.map((item) => ({
      id: item.categoryId ?? item.categoryName,
      name: item.categoryName,
      spentMinor: item.spentMinor,
      limitMinor: item.effectiveLimitMinor,
      pct: item.pct
    }))
  ];

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <h2 className="text-base font-medium text-primary">Monthly summary — {monthLabel}</h2>
        {perCategory.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No category budgets yet. Set one below to see your monthly summary here.
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Budgeted</p>
                <p className="font-semibold tabular-nums">{fmt(summary.totalEffectiveMinor)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Spent</p>
                <p className="font-semibold tabular-nums">{fmt(summary.totalSpentMinor)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Remaining</p>
                <p className="font-semibold tabular-nums">{fmt(summary.totalRemainingMinor)}</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {summary.overCount > 0 ? `${summary.overCount} over budget` : "None over budget"}
              {" · "}
              {summary.warningCount > 0
                ? `${summary.warningCount} approaching limit`
                : "none approaching"}
              {" · "}
              {summary.onTrackCount} on track. Category budgets only — the overall cap covers the
              same spending, so it is not added in.
            </p>
          </>
        )}
      </Card>

      <BudgetRings
        items={rings}
        currency={currency}
        privacy={effectivePrivacy}
        monthLabel={monthLabel}
      />
      <Card className="overflow-hidden">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium text-primary">Overall monthly cap — {monthLabel}</h2>
          {overall ? <AlertBadge alert={overall.alert} pct={overall.pct} /> : null}
        </div>
        {overall ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="tabular font-medium">{fmt(overall.spentMinor)} spent</span>
              <span className="tabular text-muted-foreground">
                of {fmt(overall.effectiveLimitMinor)}
              </span>
            </div>
            <ProgressBar pct={overall.pct} />
            <p className="text-xs text-muted-foreground">
              {overall.remainingMinor >= 0
                ? `${fmt(overall.remainingMinor)} left this month`
                : `${fmt(-overall.remainingMinor)} over cap`}
              {overall.rolloverCreditMinor > 0
                ? ` · includes ${fmt(overall.rolloverCreditMinor)} rolled over from last month (base ${fmt(overall.limitMinor)})`
                : ""}
            </p>
            <RolloverToggle categoryId={null} rollover={overall.rollover} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No overall cap set.</p>
        )}
        <div className="mt-4 border-t border-border pt-4">
          <OverallCapForm
            current={overall?.limitMinor ?? null}
            currency={currency}
            privacy={effectivePrivacy}
          />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <h2 className="mb-3 text-base font-medium text-primary">Category budgets</h2>
          {perCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No category budgets yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {perCategory.map((b) => (
                <CategoryBudgetItem
                  key={b.categoryId ?? "overall"}
                  budget={b}
                  currency={currency}
                  effectivePrivacy={effectivePrivacy}
                  fmt={fmt}
                />
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Rollover carries only last month&apos;s unspent into this month — it never compounds,
            and switching it off removes the rolled-over amount for the current month.
          </p>
        </Card>

        <SetupPanel
          title="Add / edit category budget"
          description="Select a category to establish or update its monthly limit."
          complete={overall !== null || perCategory.length > 0}
          summary={
            overall !== null || perCategory.length > 0
              ? `Overall cap ${overall ? fmt(overall.limitMinor) : "not set"} · ${perCategory.length} categor${perCategory.length === 1 ? "y" : "ies"} budgeted`
              : ""
          }
          panelId="budget-setup-panel"
        >
          <SetBudgetForm
            categories={categoriesWithoutBudget}
            hasCategories={perCategory.length > 0 || categoriesWithoutBudget.length > 0}
            currency={currency}
          />
        </SetupPanel>
      </div>
    </div>
  );
}

function CategoryBudgetItem({
  budget,
  currency,
  effectivePrivacy,
  fmt
}: {
  budget: BudgetProgress;
  currency: string;
  effectivePrivacy: boolean;
  fmt: (minor: number) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [editState, editAction] = useActionState(setBudgetAction, undefined);
  const [removeState, removeAction] = useActionState(removeBudgetAction, undefined);

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <span className="truncate">{budget.categoryName}</span>
          <AlertBadge alert={budget.alert} pct={budget.pct} />
        </span>
        <span className="tabular shrink-0 text-muted-foreground">
          {effectivePrivacy ? "••••••" : fmt(budget.spentMinor)} /{" "}
          {effectivePrivacy ? "••••••" : fmt(budget.effectiveLimitMinor)}
        </span>
      </div>
      <ProgressBar pct={budget.pct} />
      {budget.rolloverCreditMinor > 0 ? (
        <p className="text-xs text-muted-foreground">
          Includes {fmt(budget.rolloverCreditMinor)} rolled over from last month (base{" "}
          {fmt(budget.limitMinor)})
        </p>
      ) : null}

      {editing ? (
        <form
          action={async (fd) => {
            await editAction(fd);
            setEditing(false);
          }}
          className="flex flex-wrap items-end gap-2 pt-1"
        >
          <input type="hidden" name="categoryId" value={budget.categoryId ?? ""} />
          <FormError message={editState?.ok === false ? editState.error : undefined} />
          <div className="w-32">
            <label htmlFor={`edit-amount-${budget.categoryId}`} className="sr-only">
              New limit
            </label>
            <Input
              id={`edit-amount-${budget.categoryId}`}
              name="amount"
              inputMode="decimal"
              type={effectivePrivacy ? "password" : "text"}
              defaultValue={minorToDecimal(budget.limitMinor, currency)}
              placeholder="0.00"
              required
            />
          </div>
          <SubmitButton className="px-2 py-1 text-xs">Save</SubmitButton>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded px-2 py-1 text-xs text-primary hover:bg-muted"
          >
            Edit limit
          </button>
          <RolloverToggle categoryId={budget.categoryId} rollover={budget.rollover} />
          <form action={removeAction}>
            <input type="hidden" name="categoryId" value={budget.categoryId ?? ""} />
            <SubmitButton variant="ghost" className="px-2 py-1 text-xs">
              Remove budget
            </SubmitButton>
            <FormError message={removeState?.ok === false ? removeState.error : undefined} />
          </form>
        </div>
      )}
    </li>
  );
}

function OverallCapForm({
  current,
  currency,
  privacy = false
}: {
  current: number | null;
  currency: string;
  privacy?: boolean;
}) {
  const [state, action] = useActionState(setBudgetAction, undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="categoryId" value="" />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label={`Overall monthly cap (${currency})`} htmlFor="overall-amount">
        <Input
          id="overall-amount"
          name="amount"
          inputMode="decimal"
          type={privacy ? "password" : "text"}
          placeholder="5000.00"
          defaultValue={current !== null ? minorToDecimal(current, currency) : ""}
        />
      </Field>
      <SubmitButton>{current !== null ? "Update cap" : "Set cap"}</SubmitButton>
      {current !== null ? (
        <span className="text-xs text-muted-foreground">Applies every month.</span>
      ) : null}
    </form>
  );
}

function SetBudgetForm({
  categories,
  hasCategories,
  currency
}: {
  categories: { id: string; name: string }[];
  /** Whether any category exists at all (with or without a budget). */
  hasCategories: boolean;
  currency: string;
}) {
  const [state, action] = useActionState(setBudgetAction, undefined);
  if (categories.length === 0) {
    return (
      <div className="space-y-2 py-2">
        {hasCategories ? (
          <p className="text-sm text-muted-foreground">
            All existing categories have monthly budgets set. You can adjust limits by clicking
            &ldquo;Edit limit&rdquo; on any budget on the left.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No categories yet.{" "}
            <Link href="/settings/categories" className="text-primary hover:underline">
              Add one in Settings
            </Link>{" "}
            to set its monthly limit here.
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <FormError message={state?.ok === false ? state.error : undefined} />
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Category</span>
        <select
          name="categoryId"
          required
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] focus:border-primary focus:ring-4 focus:ring-primary/10"
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <Field label={`Monthly limit (${currency})`} htmlFor="budget-amount">
        <Input id="budget-amount" name="amount" required inputMode="decimal" placeholder="800.00" />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="rollover" value="on" className="size-4 accent-primary" />
        Rollover unspent to next month
      </label>
      <SubmitButton>Set budget</SubmitButton>
    </form>
  );
}
