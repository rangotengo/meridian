"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Card, Alert } from "@/components/ds/card";
import { FormError, FormSuccess } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { Amount } from "@/components/finance/amount";
import { fmtDate } from "@/lib/format";
import {
  toggleSelection,
  selectAllOnPage,
  deselectAllOnPage,
  formatBulkDeleteSummary
} from "@/lib/bulk-selection";
import { bulkDeleteEntriesAction, type BulkDeleteResult } from "@/app/(app)/actions";
import type { ActionState } from "@/server/actions/runner";
import type { EntryListItem } from "@/server/domain/entries";

export function TransactionList({
  items,
  privacy,
  tagNames,
  pagination
}: {
  items: EntryListItem[];
  privacy: boolean;
  tagNames: Record<string, string>;
  pagination: React.ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  // Names for the rows in the last delete attempt, so skipped rows can be
  // named after the list has refreshed and they are gone.
  const [attemptNames, setAttemptNames] = useState<Record<string, string>>({});
  const [deleteState, deleteAction] = useActionState(
    async (
      _prev: ActionState<BulkDeleteResult> | undefined,
      formData: FormData
    ): Promise<ActionState<BulkDeleteResult>> => {
      const res = await bulkDeleteEntriesAction(_prev, formData);
      if (res.ok && res.data) {
        const deleted = new Set(res.data.deleted);
        setSelected((prev) => prev.filter((id) => !deleted.has(id)));
        setConfirming(false);
      }
      return res;
    },
    undefined
  );

  const pageIds = items.map((e) => e.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const someSelected = pageIds.some((id) => selected.includes(id));

  // Selection is scoped to the visible page: ids that left the page (e.g.
  // after a revalidation) are never shown as selected and never submitted,
  // so the selection can never exceed the 25 ids on this page.
  const visibleSelected = selected.filter((id) => pageIds.includes(id));
  const selectedItems = items.filter((e) => visibleSelected.includes(e.id));
  const skippedWithNames =
    deleteState?.ok && deleteState.data
      ? deleteState.data.skipped.map((s) => ({
          ...s,
          name: attemptNames[s.id] ?? s.id
        }))
      : [];

  return (
    <div className="space-y-3">
      {visibleSelected.length > 0 ? (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
          <span className="text-sm font-medium" aria-live="polite">
            {visibleSelected.length} selected on this page
          </span>
          <span className="text-xs text-muted-foreground">
            Changing page or filters clears the selection.
          </span>
          {confirming ? (
            <span className="text-sm text-muted-foreground">
              Delete {visibleSelected.length} transaction
              {visibleSelected.length === 1 ? "" : "s"}? Split transactions also delete their parts;
              transfer legs also remove the transfer link. This cannot be undone.
            </span>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {confirming ? (
              <form
                action={(formData) => {
                  setAttemptNames(Object.fromEntries(selectedItems.map((e) => [e.id, e.name])));
                  deleteAction(formData);
                }}
              >
                <input type="hidden" name="entryIds" value={JSON.stringify(visibleSelected)} />
                <SubmitButton variant="destructive">
                  Confirm delete ({visibleSelected.length})
                </SubmitButton>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex h-8 items-center rounded-lg bg-destructive px-3 text-sm font-medium text-white"
              >
                Delete
              </button>
            )}
            {confirming ? (
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium hover:bg-surface-inset-hover"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setSelected([]);
                setConfirming(false);
              }}
              className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-surface-inset-hover"
            >
              Clear
            </button>
          </span>
        </Card>
      ) : null}

      {deleteState && !deleteState.ok ? <FormError message={deleteState.error} /> : null}
      {deleteState?.ok && deleteState.data ? (
        <div className="space-y-2">
          <FormSuccess
            message={formatBulkDeleteSummary(
              deleteState.data.deleted.length,
              deleteState.data.skipped.length
            )}
          />
          {skippedWithNames.length > 0 ? (
            <Alert tone="warning" title="Some transactions were not deleted">
              <ul className="list-disc pl-5">
                {skippedWithNames.map((s) => (
                  <li key={s.id}>
                    {s.name} — {s.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {/* Desktop: full table. The 640px minimum width would push the
          amount column off-screen on phones, so small screens get a
          stacked list instead (same data, same pagination). */}
      <Card className="hidden overflow-x-auto p-0 ring-1 ring-foreground/10 sm:block">
        <table className="w-full min-w-160 text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all transactions on this page"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={() =>
                    setSelected((prev) =>
                      allSelected
                        ? deselectAllOnPage(prev, pageIds)
                        : selectAllOnPage(prev, pageIds)
                    )
                  }
                />
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Date
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Description
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Account
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((e: EntryListItem) => (
              <tr key={e.id} className="transition-colors hover:bg-muted/50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${e.name}`}
                    checked={selected.includes(e.id)}
                    onChange={() => setSelected((prev) => toggleSelection(prev, e.id))}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {fmtDate(e.date)}
                </td>
                <td className="px-4 py-3">
                  <Link href={`/transactions/${e.id}`} className="font-medium hover:underline">
                    {e.transferId ? <span aria-hidden>⇄ </span> : null}
                    {e.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {e.categoryName ? <span>{e.categoryName}</span> : <span>Uncategorized</span>}
                    {e.merchant ? <span>· {e.merchant}</span> : null}
                    {e.tagIds.map((id) => (
                      <span key={id}>#{tagNames[id] ?? "tag"}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.accountName}</td>
                <td className="px-4 py-3 text-right">
                  <Amount
                    minor={-e.amountMinor}
                    currency={e.currency}
                    masked={privacy}
                    signed
                    colorize
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pagination}
      </Card>
      <Card className="p-0 ring-1 ring-foreground/10 sm:hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm">
          <input
            type="checkbox"
            aria-label="Select all transactions on this page"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected;
            }}
            onChange={() =>
              setSelected((prev) =>
                allSelected ? deselectAllOnPage(prev, pageIds) : selectAllOnPage(prev, pageIds)
              )
            }
          />
          <span className="text-muted-foreground">Select all on this page</span>
        </div>
        <ul className="divide-y divide-border">
          {items.map((e: EntryListItem) => (
            <li key={e.id} className="flex items-center gap-2 px-4 py-3">
              <input
                type="checkbox"
                aria-label={`Select ${e.name}`}
                checked={selected.includes(e.id)}
                onChange={() => setSelected((prev) => toggleSelection(prev, e.id))}
              />
              <Link
                href={`/transactions/${e.id}`}
                className="flex min-w-0 flex-1 items-start justify-between gap-3 transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {e.transferId ? <span aria-hidden>⇄ </span> : null}
                    {e.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {fmtDate(e.date)} · {e.accountName} · {e.categoryName ?? "Uncategorized"}
                  </span>
                </span>
                <Amount
                  minor={-e.amountMinor}
                  currency={e.currency}
                  masked={privacy}
                  signed
                  colorize
                  className="shrink-0 text-sm"
                />
              </Link>
            </li>
          ))}
        </ul>
        {pagination}
      </Card>
    </div>
  );
}
