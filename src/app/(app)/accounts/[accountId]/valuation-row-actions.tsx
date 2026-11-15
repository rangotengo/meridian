"use client";

import { useActionState } from "react";
import { deleteValuationAction, updateValuationAction } from "@/app/(app)/actions";
import { ConfirmDialog, Dialog, useDialogClose } from "@/components/ds/dialog";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";

export function ValuationRowActions({
  entryId,
  date,
  amount,
  kind,
  currency
}: {
  entryId: string;
  date: string;
  /** Display-signed value as a decimal string, ready for the amount input. */
  amount: string;
  kind: string;
  currency: string;
}) {
  return (
    <span className="flex items-center gap-3">
      <Dialog
        title="Edit valuation"
        description="Correct the value recorded for this date. Balances are recalculated."
        trigger={<span className="text-sm font-medium text-accent hover:underline">Edit</span>}
      >
        <ValuationEditForm
          entryId={entryId}
          date={date}
          amount={amount}
          kind={kind}
          currency={currency}
        />
      </Dialog>
      <ConfirmDialog
        title="Delete this valuation?"
        description="The entry is removed and the account balance is recalculated from the remaining valuations and transactions."
        confirmLabel="Delete valuation"
        action={deleteValuationAction}
        trigger={<span className="text-sm font-medium text-danger hover:underline">Delete</span>}
      >
        <input type="hidden" name="entryId" value={entryId} />
      </ConfirmDialog>
    </span>
  );
}

function ValuationEditForm({
  entryId,
  date,
  amount,
  kind,
  currency
}: {
  entryId: string;
  date: string;
  amount: string;
  kind: string;
  currency: string;
}) {
  const close = useDialogClose();
  const [state, action] = useActionState(updateValuationAction, undefined);

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="entryId" value={entryId} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Date" htmlFor={`val-edit-date-${entryId}`}>
        <Input
          id={`val-edit-date-${entryId}`}
          name="date"
          type="date"
          defaultValue={date}
          required
        />
      </Field>
      <Field label={`Value (${currency})`} htmlFor={`val-edit-amount-${entryId}`}>
        <Input
          id={`val-edit-amount-${entryId}`}
          name="amount"
          inputMode="decimal"
          defaultValue={amount}
          required
        />
      </Field>
      <Field label="Kind" htmlFor={`val-edit-kind-${entryId}`}>
        <Select id={`val-edit-kind-${entryId}`} name="kind" defaultValue={kind}>
          <option value="opening">Opening value</option>
          <option value="current">Current value</option>
          <option value="reconciliation">Reconciliation</option>
        </Select>
      </Field>
      {state?.ok ? <p className="text-sm text-success">Valuation saved.</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={close}
          className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
        >
          Cancel
        </button>
        <SubmitButton>Save valuation</SubmitButton>
      </div>
    </form>
  );
}
