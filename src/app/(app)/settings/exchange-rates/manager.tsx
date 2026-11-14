"use client";

import { useActionState } from "react";
import { upsertExchangeRateAction } from "./actions";
import { Field, FormError, FormSuccess, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";

export function ExchangeRateForm({
  defaultBase,
  defaultQuote,
  today
}: {
  defaultBase: string;
  defaultQuote: string;
  today: string;
}) {
  const [state, action] = useActionState(upsertExchangeRateAction, undefined);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <FormError message={state?.ok === false ? state.error : undefined} />
      {state?.ok ? <FormSuccess message="Exchange rate saved." /> : null}
      <Field label="From currency" htmlFor="fx-base">
        <Input
          id="fx-base"
          name="base"
          defaultValue={defaultBase}
          required
          minLength={3}
          maxLength={3}
          placeholder="USD"
          className="uppercase"
        />
      </Field>
      <Field label="To currency" htmlFor="fx-quote">
        <Input
          id="fx-quote"
          name="quote"
          defaultValue={defaultQuote}
          required
          minLength={3}
          maxLength={3}
          placeholder="NPR"
          className="uppercase"
        />
      </Field>
      <Field label="Rate" htmlFor="fx-rate" hint="1 unit of the from-currency, in the to-currency.">
        <Input id="fx-rate" name="rate" required inputMode="decimal" placeholder="133.50" />
      </Field>
      <Field label="Quoted on" htmlFor="fx-date" hint="Use today to refresh a stale rate.">
        <Input id="fx-date" name="quotedOn" type="date" required defaultValue={today} />
      </Field>
      <div className="sm:col-span-2">
        <SubmitButton>Save exchange rate</SubmitButton>
      </div>
    </form>
  );
}
