"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import { setBudgetAction, removeBudgetAction } from "./actions";
import { Card, Badge } from "@/components/ds/card";
import { Field, FormError, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { BudgetRings } from "@/components/finance/budget-rings";
import { fmtMoney } from "@/lib/format";
import { minorToDecimal } from "@/lib/money";
import { usePrivacy } from "@/components/layout/privacy-context";

export type Progress = {
  categoryId: string | null;
  categoryName: string;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  pct: number;
};

function pctTone(pct: number): "success" | "warning" | "destructive" {
  if (pct >= 1) return "destructive";
  if (pct >= 0.8) return "warning";
  return "success";
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

export function BudgetsView({
  currency,
  overall,
  perCategory,
  categoriesWithoutBudget,
  monthLabel,
  privacy = false
}: {
  currency: string;
  overall: Progress | null;
  perCategory: Progress[];
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
            limitMinor: overall.limitMinor,
            pct: overall.pct
          }
        ]
      : []),
    ...perCategory.map((item) => ({
      id: item.categoryId ?? item.categoryName,
      name: item.categoryName,
      spentMinor: item.spentMinor,
      limitMinor: item.limitMinor,
      pct: item.pct
    }))
  ];

  return (
    <div className="space-y-4">
      <BudgetRings
        items={rings}
        currency={currency}
        privacy={effectivePrivacy}
        monthLabel={monthLabel}
      />
      <Card className="overflow-hidden">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium text-primary">Overall monthly cap — {monthLabel}</h2>
          {overall ? (
            <Badge tone={pctTone(overall.pct)}>{Math.round(overall.pct * 100)}% used</Badge>
          ) : null}
        </div>
        {overall ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="tabular font-medium">{fmt(overall.spentMinor)} spent</span>
              <span className="tabular text-muted-foreground">of {fmt(overall.limitMinor)}</span>
            </div>
            <ProgressBar pct={overall.pct} />
            <p className="text-xs text-muted-foreground">
              {overall.remainingMinor >= 0
                ? `${fmt(overall.remainingMinor)} left this month`
                : `${fmt(-overall.remainingMinor)} over cap`}
            </p>
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
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-medium text-primary">Add / edit category budget</h2>
          <SetBudgetForm
            categories={categoriesWithoutBudget}
            hasCategories={perCategory.length > 0 || categoriesWithoutBudget.length > 0}
            currency={currency}
          />
        </Card>
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
  budget: Progress;
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
          <Badge tone={pctTone(budget.pct)}>{Math.round(budget.pct * 100)}%</Badge>
        </span>
        <span className="tabular shrink-0 text-muted-foreground">
          {effectivePrivacy ? "••••••" : fmt(budget.spentMinor)} /{" "}
          {effectivePrivacy ? "••••••" : fmt(budget.limitMinor)}
        </span>
      </div>
      <ProgressBar pct={budget.pct} />

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
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded px-2 py-1 text-xs text-primary hover:bg-muted"
          >
            Edit limit
          </button>
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
      <p className="text-xs text-muted-foreground">
        Select a category to establish or update its monthly limit.
      </p>
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
      <SubmitButton>Set budget</SubmitButton>
    </form>
  );
}
