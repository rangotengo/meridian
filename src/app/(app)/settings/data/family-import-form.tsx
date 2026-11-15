"use client";

import { useActionState } from "react";
import { importFamilyExportAction } from "./actions";
import { FormError } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { pluralize } from "@/lib/format";

export function FamilyImportForm() {
  const [state, action] = useActionState(importFamilyExportAction, undefined);
  const skipped = state?.ok ? state.data?.skipped : undefined;
  return (
    <form action={action} className="space-y-3">
      <FormError message={state?.ok === false ? state.error : undefined} />
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Meridian export file</span>
        <input
          name="familyExport"
          type="file"
          accept=".json,application/json"
          required
          className="block w-full cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-surface-inset file:px-2 file:py-1 file:text-sm file:font-medium hover:file:bg-surface-hover"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Upload a JSON export downloaded from any Meridian instance. The restore runs only in an
        empty family and applies all-or-nothing: accounts, entries, transfers, budgets, recurring
        series, and saved filters are recreated with new ids. Members are matched by email — shares
        and saved filters for people who have not joined this family yet are skipped.
      </p>
      <SubmitButton>Restore export</SubmitButton>
      {state?.ok && state.data ? (
        <div
          className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success"
          role="status"
        >
          Restored {pluralize(state.data.accounts, "account")},{" "}
          {pluralize(state.data.entries, "entry")}, {pluralize(state.data.transfers, "transfer")},{" "}
          {pluralize(state.data.budgets, "budget")}, and{" "}
          {pluralize(state.data.recurring, "recurring series")}.
          {skipped && skipped.shares + skipped.savedFilters > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Skipped {pluralize(skipped.shares, "share")} and{" "}
              {pluralize(skipped.savedFilters, "saved filter")} belonging to people who are not
              members of this family.
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
