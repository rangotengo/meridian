"use client";

import Link from "next/link";
import { Fragment, useActionState, useEffect, useState } from "react";
import { Card, Alert } from "@/components/ds/card";
import { Field, FormError, FormSuccess, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { Amount } from "@/components/finance/amount";
import { fmtDate } from "@/lib/format";
import {
  toggleSelection,
  selectAllOnPage,
  deselectAllOnPage,
  formatBulkDeleteSummary,
  formatBulkRecategoriseSummary
} from "@/lib/bulk-selection";
import {
  bulkDeleteEntriesAction,
  bulkRecategoriseEntriesAction,
  updateTransactionAction,
  type BulkDeleteResult,
  type BulkRecategoriseResult
} from "@/app/(app)/actions";
import type { ActionState } from "@/server/actions/runner";
import type { EntryListItem } from "@/server/domain/entries";

type AccountLevel = "full_control" | "read_write" | "read_only";

/**
 * Inline edit for one row. Reuses updateTransactionAction, so the fields,
 * limits and server-side rules are exactly the detail page's: description
 * (core, full control only), category and merchant (annotations, any level
 * above read-only). Date and amount stay on the detail page — they are
 * locked for linked transfer legs and split parents, and editing them in a
 * table row would hide those constraints. On a successful save the form
 * closes; a failed save stays open with the error.
 */
function InlineEditForm({
  entry,
  categories,
  canCore,
  canAnnotate,
  onDone
}: {
  entry: EntryListItem;
  categories: { id: string; name: string }[];
  canCore: boolean;
  canAnnotate: boolean;
  onDone: () => void;
}) {
  const [state, action] = useActionState(updateTransactionAction, undefined);
  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="entryId" value={entry.id} />
      <Field label="Description" htmlFor={`inline-name-${entry.id}`}>
        <Input
          id={`inline-name-${entry.id}`}
          name="name"
          defaultValue={entry.name}
          required
          maxLength={240}
          disabled={!canCore}
        />
      </Field>
      <Field label="Category" htmlFor={`inline-category-${entry.id}`}>
        <Select
          id={`inline-category-${entry.id}`}
          name="categoryId"
          defaultValue={entry.categoryId ?? ""}
          disabled={!canAnnotate}
        >
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Merchant" htmlFor={`inline-merchant-${entry.id}`}>
        <Input
          id={`inline-merchant-${entry.id}`}
          name="merchant"
          defaultValue={entry.merchant ?? ""}
          maxLength={120}
          disabled={!canAnnotate}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
        <SubmitButton>Save</SubmitButton>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-surface-inset-hover"
        >
          Cancel
        </button>
        {!canCore ? (
          <span className="text-xs text-muted-foreground">
            Your access level cannot change the description.
          </span>
        ) : null}
      </div>
      {state && !state.ok ? (
        <div className="sm:col-span-3">
          <FormError message={state.error} />
        </div>
      ) : null}
    </form>
  );
}

export function TransactionList({
  items,
  privacy,
  tagNames,
  categories,
  accountLevels,
  pagination
}: {
  items: EntryListItem[];
  privacy: boolean;
  tagNames: Record<string, string>;
  categories: { id: string; name: string }[];
  accountLevels: Record<string, AccountLevel>;
  pagination: React.ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Category chosen in the bulk-recategorise control; "__none__" means no
  // choice yet, so Apply stays disabled until one is made ("" is a real
  // choice: Uncategorized).
  const [recatCategory, setRecatCategory] = useState("__none__");
  // Names for the rows in the last bulk attempt, so skipped rows can be
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
  const [recatState, recatAction] = useActionState(
    async (
      _prev: ActionState<BulkRecategoriseResult> | undefined,
      formData: FormData
    ): Promise<ActionState<BulkRecategoriseResult>> => {
      const res = await bulkRecategoriseEntriesAction(_prev, formData);
      if (res.ok && res.data) {
        const updated = new Set(res.data.updated);
        setSelected((prev) => prev.filter((id) => !updated.has(id)));
        setRecatCategory("__none__");
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
  const recatSkippedWithNames =
    recatState?.ok && recatState.data
      ? recatState.data.skipped.map((s) => ({
          ...s,
          name: attemptNames[s.id] ?? s.id
        }))
      : [];
  // The list never shows an Edit button for an account the actor cannot
  // annotate; the server enforces the same levels on save.
  const levelFor = (e: EntryListItem): AccountLevel => accountLevels[e.accountId] ?? "read_only";

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
          {!confirming ? (
            <form
              action={(formData) => {
                setAttemptNames(Object.fromEntries(selectedItems.map((e) => [e.id, e.name])));
                recatAction(formData);
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <input type="hidden" name="entryIds" value={JSON.stringify(visibleSelected)} />
              <label htmlFor="bulk-category" className="sr-only">
                Category for selected transactions
              </label>
              <Select
                id="bulk-category"
                name="categoryId"
                value={recatCategory}
                onChange={(ev) => setRecatCategory(ev.target.value)}
                className="w-auto"
              >
                <option value="__none__" disabled>
                  Recategorise to…
                </option>
                <option value="">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <SubmitButton variant="secondary" disabled={recatCategory === "__none__"}>
                Apply to {visibleSelected.length}
              </SubmitButton>
            </form>
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

      {recatState && !recatState.ok ? <FormError message={recatState.error} /> : null}
      {recatState?.ok && recatState.data ? (
        <div className="space-y-2">
          <FormSuccess
            message={formatBulkRecategoriseSummary(
              recatState.data.updated.length,
              recatState.data.skipped.length
            )}
          />
          {recatSkippedWithNames.length > 0 ? (
            <Alert tone="warning" title="Some transactions were not updated">
              <ul className="list-disc pl-5">
                {recatSkippedWithNames.map((s) => (
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
              <th scope="col" className="w-16 px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((e: EntryListItem) => {
              const level = levelFor(e);
              const canEdit = level !== "read_only";
              const editing = editingId === e.id;
              return (
                <Fragment key={e.id}>
                  <tr className="transition-colors hover:bg-muted/50">
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
                        {e.categoryName ? (
                          <span>{e.categoryName}</span>
                        ) : (
                          <span>Uncategorized</span>
                        )}
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
                    <td className="px-4 py-3 text-right">
                      {canEdit ? (
                        <button
                          type="button"
                          aria-label={`Edit ${e.name}`}
                          onClick={() => setEditingId(editing ? null : e.id)}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          {editing ? "Close" : "Edit"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {editing ? (
                    <tr>
                      <td colSpan={6} className="bg-muted/30 px-4 py-4">
                        <InlineEditForm
                          entry={e}
                          categories={categories}
                          canCore={level === "full_control"}
                          canAnnotate={level !== "read_only"}
                          onDone={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
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
          {items.map((e: EntryListItem) => {
            const level = levelFor(e);
            const canEdit = level !== "read_only";
            const editing = editingId === e.id;
            return (
              <li key={e.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
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
                  {canEdit ? (
                    <button
                      type="button"
                      aria-label={`Edit ${e.name}`}
                      onClick={() => setEditingId(editing ? null : e.id)}
                      className="shrink-0 text-sm font-medium text-primary hover:underline"
                    >
                      {editing ? "Close" : "Edit"}
                    </button>
                  ) : null}
                </div>
                {editing ? (
                  <div className="mt-3 border-t border-border pt-3">
                    <InlineEditForm
                      entry={e}
                      categories={categories}
                      canCore={level === "full_control"}
                      canAnnotate={level !== "read_only"}
                      onDone={() => setEditingId(null)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {pagination}
      </Card>
    </div>
  );
}
