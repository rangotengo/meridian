"use client";

import { useActionState, useState } from "react";
import { createAccountAction } from "@/app/(app)/accounts/actions";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";

const TYPES = [
  { value: "depository", label: "Cash", hint: "Checking, savings, wallet" },
  { value: "credit_card", label: "Credit card", hint: "Track what you owe" },
  { value: "other_asset", label: "Other asset", hint: "Valued by records you enter" },
  { value: "other_liability", label: "Other liability", hint: "A debt you track manually" }
];

const TRACKING = [
  {
    value: "valuation",
    label: "From valuations I record",
    hint: "Balance is the latest value you enter — property, investments"
  },
  {
    value: "transactions",
    label: "From its transactions",
    hint: "Balance follows money in and out — a loan you lend and collect"
  }
];

export function NewAccountForm({
  defaultCurrency,
  today
}: {
  defaultCurrency: string;
  today: string;
}) {
  const [state, action] = useActionState(createAccountAction, undefined);
  const [type, setType] = useState("depository");
  const [tracking, setTracking] = useState("valuation");
  const showTracking = type === "other_asset" || type === "other_liability";

  return (
    <form action={action} className="space-y-5">
      <FormError message={state?.ok === false ? state.error : undefined} />

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Account type</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {TYPES.map((t) => (
            <label
              key={t.value}
              className={`cursor-pointer rounded-xl border p-4 ${
                type === t.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              }`}
            >
              <input
                type="radio"
                name="type"
                value={t.value}
                checked={type === t.value}
                onChange={() => setType(t.value)}
                className="sr-only"
              />
              <span className="block text-sm font-medium">{t.label}</span>
              <span className="block text-xs text-muted-foreground">{t.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {showTracking ? (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Balance tracking</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {TRACKING.map((t) => (
              <label
                key={t.value}
                className={`cursor-pointer rounded-xl border p-4 ${
                  tracking === t.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <input
                  type="radio"
                  name="balanceTracking"
                  value={t.value}
                  checked={tracking === t.value}
                  onChange={() => setTracking(t.value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium">{t.label}</span>
                <span className="block text-xs text-muted-foreground">{t.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" required maxLength={120} placeholder="Everyday checking" />
        </Field>
        <Field label="Institution (optional)" htmlFor="institution">
          <Input id="institution" name="institution" maxLength={120} placeholder="Bank name" />
        </Field>
        <Field label="Currency" htmlFor="currency">
          <Select id="currency" name="currency" defaultValue={defaultCurrency}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={
            type === "credit_card" || type === "other_liability"
              ? "Opening balance owed"
              : "Opening balance"
          }
          htmlFor="openingBalance"
          hint={
            type === "credit_card" || type === "other_liability"
              ? "Amount already owed at open date."
              : "Value held on the open date."
          }
        >
          <Input id="openingBalance" name="openingBalance" inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field label="Opened on" htmlFor="openedOn">
          <Input id="openedOn" name="openedOn" type="date" defaultValue={today} required />
        </Field>
      </div>

      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="hidden" name="includedInReports" value="off" />
          <input
            type="checkbox"
            name="includedInReports"
            value="on"
            defaultChecked
            className="h-4 w-4"
          />
          Include this account in reports
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="joint" defaultChecked className="h-4 w-4" />
          Shared with the whole family (uncheck to keep it personal)
        </label>
      </div>

      <SubmitButton>Create account</SubmitButton>
    </form>
  );
}

export const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "INR",
  "NPR",
  "SGD",
  "HKD",
  "BRL",
  "ZAR"
];
