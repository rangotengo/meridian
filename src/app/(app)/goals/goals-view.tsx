"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import {
  createGoalAction,
  deleteGoalAction,
  setGoalStatusAction,
  updateGoalAction
} from "./actions";
import { Card, Badge, EmptyState } from "@/components/ds/card";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { fmtMoney } from "@/lib/format";
import { minorToDecimal } from "@/lib/money";
import { usePrivacy } from "@/components/layout/privacy-context";
import type { GoalProgress } from "@/server/domain/goals";

function ProgressBar({ pct }: { pct: number | null }) {
  const clamped = pct === null ? 0 : Math.min(pct, 1);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-border/60"
      role="progressbar"
      aria-valuenow={pct === null ? undefined : Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full ${pct !== null && pct >= 1 ? "bg-success" : "bg-primary"}`}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

function GoalCard({ goal, privacy }: { goal: GoalProgress; privacy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusState, statusAction] = useActionState(setGoalStatusAction, undefined);
  const [deleteState, deleteAction] = useActionState(deleteGoalAction, undefined);
  const [updateState, updateAction] = useActionState(updateGoalAction, undefined);
  const fmt = (minor: number) => (privacy ? "•••••" : fmtMoney(minor, goal.currency));

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-medium">{goal.name}</h3>
          <p className="text-xs text-muted-foreground">
            {goal.linkType === "account" ? "Account" : "Category"}:{" "}
            {goal.linkRemoved ? "link removed" : (goal.linkName ?? "—")}
            {goal.deadline ? ` · due ${goal.deadline}` : " · no deadline"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {goal.reached ? <Badge tone="success">Reached</Badge> : null}
          {goal.pastDue ? <Badge tone="warning">Past due</Badge> : null}
          {goal.linkRemoved ? <Badge tone="destructive">Link removed</Badge> : null}
          {goal.status === "achieved" ? <Badge tone="success">Achieved</Badge> : null}
          {goal.status === "archived" ? <Badge tone="warning">Archived</Badge> : null}
        </div>
      </div>

      {goal.linkRemoved ? (
        <p className="text-sm text-muted-foreground">
          The linked {goal.linkType} was removed, so progress can no longer be measured. The target
          is kept for reference — archive or delete the goal, or create a new one for a different{" "}
          {goal.linkType}.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between text-sm">
            <span className="tabular font-medium">{fmt(goal.progressMinor ?? 0)} saved</span>
            <span className="tabular text-muted-foreground">of {fmt(goal.targetMinor)}</span>
          </div>
          <ProgressBar pct={goal.pct} />
          <p className="text-xs text-muted-foreground">
            {goal.pct !== null ? `${Math.round(goal.pct * 100)}%` : "—"}
            {goal.remainingMinor !== null && goal.remainingMinor > 0
              ? ` · ${fmt(goal.remainingMinor)} to go`
              : goal.reached
                ? " · target reached"
                : ""}
            {goal.fxIncomplete ? " · some income could not be converted (missing rate)" : ""}
          </p>
        </>
      )}

      {editing ? (
        <form action={updateAction} className="space-y-3 border-t border-border pt-3">
          <input type="hidden" name="goalId" value={goal.id} />
          <input type="hidden" name="currency" value={goal.currency} />
          <Field label="Name">
            <Input name="name" defaultValue={goal.name} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Target (${goal.currency})`}>
              <Input
                name="amount"
                inputMode="decimal"
                defaultValue={minorToDecimal(goal.targetMinor, goal.currency)}
              />
            </Field>
            <Field label="Deadline">
              <Input name="deadline" type="date" defaultValue={goal.deadline ?? ""} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            The link never changes — it defines what progress means. To track something else, delete
            this goal and create a new one.
          </p>
          <FormError message={updateState?.ok === false ? updateState.error : undefined} />
          <div className="flex gap-2">
            <SubmitButton>Save changes</SubmitButton>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-border/50"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {goal.status === "active" ? (
            <form action={statusAction}>
              <input type="hidden" name="goalId" value={goal.id} />
              <input type="hidden" name="status" value="achieved" />
              <SubmitButton>Mark achieved</SubmitButton>
            </form>
          ) : null}
          {goal.status === "active" ? (
            <form action={statusAction}>
              <input type="hidden" name="goalId" value={goal.id} />
              <input type="hidden" name="status" value="archived" />
              <SubmitButton>Archive</SubmitButton>
            </form>
          ) : (
            <form action={statusAction}>
              <input type="hidden" name="goalId" value={goal.id} />
              <input type="hidden" name="status" value="active" />
              <SubmitButton>Reactivate</SubmitButton>
            </form>
          )}
          <button
            type="button"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-border/50"
            onClick={() => setEditing((v) => !v)}
          >
            Edit
          </button>
          {confirmDelete ? (
            <form action={deleteAction}>
              <input type="hidden" name="goalId" value={goal.id} />
              <SubmitButton>Confirm delete</SubmitButton>
            </form>
          ) : (
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          )}
          <FormError
            message={
              statusState?.ok === false
                ? statusState.error
                : deleteState?.ok === false
                  ? deleteState.error
                  : undefined
            }
          />
        </div>
      )}
    </Card>
  );
}

export function GoalsView({
  goals,
  accounts,
  categories,
  currency,
  privacy = false
}: {
  goals: GoalProgress[];
  accounts: { id: string; name: string; currency: string }[];
  categories: { id: string; name: string }[];
  currency: string;
  privacy?: boolean;
}) {
  const contextPrivacy = usePrivacy();
  const effectivePrivacy = privacy || contextPrivacy;
  const [linkType, setLinkType] = useState<"account" | "category">("account");
  const [accountId, setAccountId] = useState("");
  // The target is parsed in the goal's own currency: the linked account's
  // currency for account goals, the family currency for category goals.
  // Show that currency on the label so a foreign-currency account is not
  // mislabelled with the family currency.
  const targetCurrency =
    linkType === "account"
      ? (accounts.find((a) => a.id === accountId)?.currency ?? currency)
      : currency;
  const [createState, createAction] = useActionState(createGoalAction, undefined);
  const active = goals.filter((g) => g.status !== "archived");
  const archived = goals.filter((g) => g.status === "archived");

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">New goal</h2>
        <form action={createAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input name="name" placeholder="e.g. Emergency fund" required />
            </Field>
            <Field label={`Target amount (${targetCurrency})`}>
              <Input name="amount" inputMode="decimal" placeholder="50000" required />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Tracks">
              <Select
                name="linkType"
                value={linkType}
                onChange={(e) => setLinkType(e.target.value as "account" | "category")}
              >
                <option value="account">An account (balance growth)</option>
                <option value="category">A category (income earned)</option>
              </Select>
            </Field>
            {linkType === "account" ? (
              <Field label="Account">
                <Select
                  name="accountId"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  required
                >
                  <option value="">Choose an account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Category">
                <Select name="categoryId" required>
                  <option value="">Choose a category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Deadline (optional)">
              <Input name="deadline" type="date" />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Account goals measure how much the balance has grown since today. Category goals measure
            income earned in that category from today onward.
          </p>
          <FormError message={createState?.ok === false ? createState.error : undefined} />
          <SubmitButton>Create goal</SubmitButton>
        </form>
      </Card>

      {active.length === 0 ? (
        <EmptyState
          title="No goals yet"
          hint="Create your first goal above — for example an emergency fund linked to your savings account."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {active.map((goal) => (
            <GoalCard key={goal.id} goal={goal} privacy={effectivePrivacy} />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Archived</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {archived.map((goal) => (
              <GoalCard key={goal.id} goal={goal} privacy={effectivePrivacy} />
            ))}
          </div>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        <Link href="/budgets" className="underline underline-offset-2">
          Budgets
        </Link>{" "}
        cap what you spend each month; goals track what you set aside. The two pair well: a goal
        linked to a savings account grows when spending stays under budget.
      </p>
    </div>
  );
}
