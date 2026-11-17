"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { setLoanRateAction } from "./actions";
import { Alert, Badge, Card, EmptyState } from "@/components/ds/card";
import { Field, FormError, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { fmtMoney } from "@/lib/format";
import { formatMonthKey } from "@/lib/datetime";
import { parseAmountToMinor } from "@/lib/money";
import { bpsToPercentString, planPayoff, type PayoffPlan } from "@/lib/payoff";

export type LoanView = {
  id: string;
  name: string;
  institution: string | null;
  currency: string;
  /** Amount still owed, in minor units (positive). */
  displayBalanceMinor: number;
  /** Annual rate in basis points, or null when unknown. */
  interestRateBps: number | null;
  canEdit: boolean;
};

function PlanSummary({
  label,
  plan,
  currency,
  highlight
}: {
  label: string;
  plan: PayoffPlan;
  currency: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${highlight ? "border-success/40 bg-success/5" : "border-border"}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {plan.payoffMonths === null ? (
        <p className="mt-2 text-sm font-medium text-destructive">
          Never — this payment does not cover the monthly interest.
        </p>
      ) : (
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Debt-free</dt>
            <dd className="font-medium">
              {plan.payoffMonth ? formatMonthKey(plan.payoffMonth) : "—"}
              <span className="text-muted-foreground"> ({plan.payoffMonths} mo)</span>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Total interest</dt>
            <dd className="font-medium tabular-nums">
              {plan.totalInterestMinor !== null ? fmtMoney(plan.totalInterestMinor, currency) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Total paid</dt>
            <dd className="font-medium tabular-nums">
              {plan.totalPaidMinor !== null ? fmtMoney(plan.totalPaidMinor, currency) : "—"}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function LoanCard({
  loan,
  currentMonth,
  privacy
}: {
  loan: LoanView;
  currentMonth: string;
  privacy: boolean;
}) {
  const [rateState, rateAction] = useActionState(setLoanRateAction, undefined);
  const [monthlyPayment, setMonthlyPayment] = useState("");
  const [extraPayment, setExtraPayment] = useState("");

  const parsed = useMemo(() => {
    if (!monthlyPayment.trim()) return { ok: false as const };
    try {
      const monthly = parseAmountToMinor(monthlyPayment, loan.currency);
      const extra = extraPayment.trim() ? parseAmountToMinor(extraPayment, loan.currency) : 0;
      if (monthly <= 0)
        return { ok: false as const, error: "Monthly payment must be more than 0." };
      if (extra < 0) return { ok: false as const, error: "Extra payment can't be negative." };
      return { ok: true as const, monthly, extra };
    } catch {
      return { ok: false as const, error: "Enter amounts as numbers, e.g. 10000." };
    }
  }, [monthlyPayment, extraPayment, loan.currency]);

  const comparison =
    parsed.ok && loan.displayBalanceMinor > 0
      ? planPayoff({
          balanceMinor: loan.displayBalanceMinor,
          annualRateBps: loan.interestRateBps,
          monthlyPaymentMinor: parsed.monthly,
          extraMonthlyPaymentMinor: parsed.extra,
          fromMonth: currentMonth
        })
      : null;

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{loan.name}</p>
          {loan.institution ? (
            <p className="text-sm text-muted-foreground">{loan.institution}</p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Still owed</p>
          <p className="font-medium tabular-nums">
            {privacy ? "••••" : fmtMoney(loan.displayBalanceMinor, loan.currency)}
          </p>
        </div>
      </div>

      <form action={rateAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="accountId" value={loan.id} />
        <Field
          label="Annual interest rate (%)"
          htmlFor={`rate-${loan.id}`}
          hint={
            loan.interestRateBps === null ? "No rate set — plans assume 0% interest." : undefined
          }
        >
          <Input
            id={`rate-${loan.id}`}
            name="rate"
            inputMode="decimal"
            placeholder="e.g. 12.5"
            defaultValue={
              loan.interestRateBps !== null ? bpsToPercentString(loan.interestRateBps) : ""
            }
            disabled={!loan.canEdit}
          />
        </Field>
        {loan.canEdit ? <SubmitButton>Save rate</SubmitButton> : null}
      </form>
      <FormError message={!rateState?.ok ? rateState?.error : undefined} />
      {loan.interestRateBps !== null ? (
        <Badge>{bpsToPercentString(loan.interestRateBps)}% APR</Badge>
      ) : (
        <Badge>No interest rate set</Badge>
      )}

      {loan.displayBalanceMinor <= 0 ? (
        <Alert title="Nothing owed">
          This loan shows a zero balance, so there is nothing to plan.
        </Alert>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={`Monthly payment (${loan.currency})`} htmlFor={`pay-${loan.id}`}>
              <Input
                id={`pay-${loan.id}`}
                inputMode="decimal"
                placeholder="e.g. 10000"
                value={monthlyPayment}
                onChange={(e) => setMonthlyPayment(e.target.value)}
              />
            </Field>
            <Field label={`Extra per month (${loan.currency})`} htmlFor={`extra-${loan.id}`}>
              <Input
                id={`extra-${loan.id}`}
                inputMode="decimal"
                placeholder="e.g. 5000"
                value={extraPayment}
                onChange={(e) => setExtraPayment(e.target.value)}
              />
            </Field>
          </div>
          {parsed.ok === false && "error" in parsed && parsed.error ? (
            <p role="alert" className="text-sm text-destructive">
              {parsed.error}
            </p>
          ) : null}

          {comparison ? (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <PlanSummary
                  label="Current payment"
                  plan={comparison.base}
                  currency={loan.currency}
                />
                <PlanSummary
                  label="With extra payment"
                  plan={comparison.withExtra}
                  currency={loan.currency}
                  highlight
                />
              </div>
              {parsed.ok &&
              comparison.interestSavedMinor !== null &&
              comparison.monthsSaved !== null ? (
                <p className="text-sm">
                  The extra {fmtMoney(parsed.extra, loan.currency)}/month saves{" "}
                  <strong>{fmtMoney(comparison.interestSavedMinor, loan.currency)}</strong> of
                  interest and <strong>{comparison.monthsSaved} months</strong>.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Savings can only be calculated when both plans pay the loan off.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Enter a monthly payment to see the payoff date and interest.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export function DebtsView({
  loans,
  currentMonth,
  privacy
}: {
  loans: LoanView[];
  currentMonth: string;
  privacy: boolean;
}) {
  if (loans.length === 0) {
    return (
      <EmptyState
        title="No loan accounts yet"
        hint="Add a loan account (type “Other liability”) to plan its payoff here."
        action={
          <Link
            href="/accounts/new"
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            Add an account
          </Link>
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      {loans.map((loan) => (
        <LoanCard key={loan.id} loan={loan} currentMonth={currentMonth} privacy={privacy} />
      ))}
      <p className="text-xs leading-relaxed text-muted-foreground">
        How the plan works: interest compounds monthly on the balance at the start of each month at
        the annual rate ÷ 12. Your payment is applied at month end — first to that month&apos;s
        interest, the rest to principal — and the final payment is whatever is left. The monthly
        payment stays fixed, and the plan assumes no new borrowing and no fees. A plan that would
        take more than 50 years is shown as “never”. This is a planning estimate, not a payoff quote
        from your lender. Credit cards are not shown here: they are revolving debt, not fixed loans.
      </p>
    </div>
  );
}
