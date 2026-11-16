"use client";

import { useActionState, useState } from "react";
import {
  createRecurringAction,
  toggleRecurringAction,
  deleteRecurringAction,
  skipNextOccurrenceAction
} from "./actions";
import { Card, Badge } from "@/components/ds/card";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { ConfirmDialog } from "@/components/ds/dialog";
import { fmtMoney } from "@/lib/format";

type Series = {
  id: string;
  accountName: string;
  name: string;
  merchant: string | null;
  amountMinor: number;
  currency: string;
  frequency: string;
  nextDue: string;
  active: boolean;
  accountStatus: string;
  canManage: boolean;
};

type Option = { id: string; name: string; currency: string };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

function frequencyLabel(frequency: string, config: Record<string, unknown>): string {
  switch (frequency) {
    case "weekly":
      return `Weekly on ${WEEKDAYS[Number(config.weekday ?? 0)] ?? "?"}`;
    case "yearly":
      return `Yearly on ${MONTHS[Number(config.month ?? 1) - 1] ?? "?"} ${Number(config.day ?? 1)}`;
    default:
      return `Monthly on day ${Number(config.dayOfMonth ?? 1)}`;
  }
}

export function RecurringManager({
  series,
  accounts,
  categories
}: {
  series: (Series & { config: Record<string, unknown> })[];
  accounts: Option[];
  categories: { id: string; name: string }[];
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">New recurring series</h2>
        <CreateForm accounts={accounts} categories={categories} />
      </Card>
      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Existing series</h2>
        {series.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Add rent, salary, subscriptions…
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {series.map((s) => (
              <li key={s.id} className="space-y-2 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{s.name}</span>
                      {!s.active ? <Badge tone="neutral">paused</Badge> : null}
                      {s.accountStatus !== "active" ? (
                        <Badge tone="warning">account closed</Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.accountName} · {frequencyLabel(s.frequency, s.config)} · next {s.nextDue}
                    </p>
                  </div>
                  <span className="tabular shrink-0 font-medium">
                    {s.amountMinor < 0 ? "Income · " : "Expense · "}
                    {fmtMoney(Math.abs(s.amountMinor), s.currency)}
                  </span>
                </div>
                {s.canManage ? (
                  <div className="flex gap-2">
                    <form action={toggleRecurringAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="active" value={s.active ? "false" : "true"} />
                      <SubmitButton variant="ghost">{s.active ? "Pause" : "Resume"}</SubmitButton>
                    </form>
                    <ConfirmDialog
                      trigger={
                        <span className="inline-flex rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover">
                          Skip next
                        </span>
                      }
                      title={`Skip next due date for ${s.name}?`}
                      description={`Advances the schedule by one interval without creating a transaction. Next due will become the following interval.`}
                      confirmLabel="Skip next"
                      variant="secondary"
                      action={skipNextOccurrenceAction}
                    >
                      <input type="hidden" name="id" value={s.id} />
                    </ConfirmDialog>
                    <ConfirmDialog
                      trigger={
                        <span className="inline-flex rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover">
                          Delete
                        </span>
                      }
                      title={`Delete recurring series ${s.name}?`}
                      description="Previously generated transactions will remain; future occurrences will not be scheduled."
                      confirmLabel="Delete series"
                      action={deleteRecurringAction}
                    >
                      <input type="hidden" name="id" value={s.id} />
                    </ConfirmDialog>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CreateForm({
  accounts,
  categories
}: {
  accounts: Option[];
  categories: { id: string; name: string }[];
}) {
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [frequency, setFrequency] = useState("monthly");
  const [state, action] = useActionState(createRecurringAction, undefined);

  return (
    <form action={action} className="space-y-4">
      <FormError message={state?.ok === false ? state.error : undefined} />
      <div
        className="grid grid-cols-2 gap-1 rounded-lg bg-surface-inset p-1"
        role="group"
        aria-label="Series type"
      >
        {(["expense", "income"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors ${
              kind === k
                ? "bg-surface text-primary shadow-sm"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      <input type="hidden" name="kind" value={kind} />
      <Field label="Name" htmlFor="recurring-name">
        <Input
          id="recurring-name"
          name="name"
          required
          maxLength={240}
          placeholder={kind === "income" ? "Salary" : "Rent"}
        />
      </Field>
      <Field label="Account" htmlFor="recurring-account">
        <Select id="recurring-account" name="accountId" required>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" htmlFor="recurring-amount">
          <Input
            id="recurring-amount"
            name="amount"
            required
            inputMode="decimal"
            placeholder="2400.00"
          />
        </Field>
        <Field label="Category (optional)" htmlFor="recurring-category">
          <Select id="recurring-category" name="categoryId">
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Frequency" htmlFor="recurring-frequency">
        <Select
          id="recurring-frequency"
          name="frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
        >
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly</option>
          <option value="yearly">Yearly</option>
        </Select>
      </Field>
      {frequency === "monthly" ? (
        <Field label="Day of month (1-31)" htmlFor="recurring-day">
          <Input
            id="recurring-day"
            name="dayOfMonth"
            type="number"
            min={1}
            max={31}
            defaultValue={1}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Clamped to month length (31 → Feb 28/29).
          </p>
        </Field>
      ) : null}
      {frequency === "weekly" ? (
        <Field label="Weekday" htmlFor="recurring-weekday">
          <Select id="recurring-weekday" name="weekday" defaultValue="1">
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {frequency === "yearly" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Month" htmlFor="recurring-month">
            <Select id="recurring-month" name="month" defaultValue="1">
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Day" htmlFor="recurring-yearly-day">
            <Input
              id="recurring-yearly-day"
              name="day"
              type="number"
              min={1}
              max={31}
              defaultValue={1}
            />
          </Field>
        </div>
      ) : null}
      <Field label="First due date" htmlFor="recurring-next-due">
        <Input id="recurring-next-due" name="nextDue" type="date" required />
      </Field>
      <Field label="Merchant (optional)" htmlFor="recurring-merchant">
        <Input id="recurring-merchant" name="merchant" maxLength={120} />
      </Field>
      <SubmitButton>Create series</SubmitButton>
    </form>
  );
}
