"use client";

import { useActionState, useState } from "react";
import {
  updateTransactionAction,
  splitEntryAction,
  linkTransferAction,
  deleteEntryAction,
  unsplitEntryAction,
  unlinkTransferAction
} from "@/app/(app)/actions";
import Link from "next/link";
import { Card, Alert } from "@/components/ds/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { ConfirmDialog, Dialog } from "@/components/ds/dialog";
import { TagPicker } from "@/components/ds/tag-picker";
import { minorToDecimal, tryParseAmountToMinor } from "@/lib/money";
import { usePrivacy } from "@/components/layout/privacy-context";

export type DetailProps = {
  entry: {
    id: string;
    date: string;
    name: string;
    notes: string | null;
    amountMinor: number;
    currency: string;
  };
  level: "full_control" | "read_write" | "read_only";
  categories: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  categoryId: string | null;
  tagIds: string[];
  merchant: string | null;
  transferId: string | null;
  transferPartnerName?: string;
  parentId: string | null;
  splits: { id: string; name: string; amountMinor: number }[];
  suggestions: {
    entryId: string;
    date: string;
    name: string;
    amountMinor: number;
    accountName: string;
  }[];
};

function displayAmount(minor: number, currency: string): string {
  const abs = Math.abs(minor);
  return minorToDecimal(abs, currency);
}

export function TransactionDetailClient(p: DetailProps) {
  const privacy = usePrivacy();
  const isExpense = p.entry.amountMinor > 0;
  const canCore = p.level === "full_control";
  const canAnnotate = p.level !== "read_only";
  const isLinked = Boolean(p.transferId);
  // Date/amount are locked while linked: disabled inputs are not submitted,
  // so annotation-only saves reach the server without the protected fields.
  const coreLocked = !canCore || isLinked;
  const [updateState, updateAction] = useActionState(updateTransactionAction, undefined);
  const [linkState, linkAction] = useActionState(linkTransferAction, undefined);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <form action={updateAction} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="entryId" value={p.entry.id} />
          <input type="hidden" name="ledgerSign" value={isExpense ? "1" : "-1"} />
          <FormError message={updateState?.ok === false ? updateState.error : undefined} />

          <Field label="Description" htmlFor="d-name">
            <Input
              id="d-name"
              name="name"
              defaultValue={p.entry.name}
              required
              maxLength={240}
              disabled={!canCore}
            />
          </Field>
          <Field
            label="Date"
            htmlFor="d-date"
            hint={isLinked ? "Linked transfer — unlink to change the date." : undefined}
          >
            <Input
              id="d-date"
              name="date"
              type="date"
              defaultValue={p.entry.date}
              disabled={coreLocked}
            />
          </Field>
          <Field
            label={`Amount (${p.entry.currency})`}
            htmlFor="d-amount"
            hint={
              isLinked
                ? "Linked transfer — unlink to change the amount."
                : canCore
                  ? undefined
                  : "Your access level cannot change amounts."
            }
          >
            <Input
              id="d-amount"
              name="amount"
              inputMode="decimal"
              type={privacy ? "password" : "text"}
              defaultValue={displayAmount(p.entry.amountMinor, p.entry.currency)}
              disabled={coreLocked}
            />
          </Field>
          <Field label="Category" htmlFor="d-category">
            <Select
              id="d-category"
              name="categoryId"
              defaultValue={p.categoryId ?? ""}
              disabled={!canAnnotate}
            >
              <option value="">Uncategorized</option>
              {p.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Merchant" htmlFor="d-merchant">
            <Input
              id="d-merchant"
              name="merchant"
              defaultValue={p.merchant ?? ""}
              maxLength={120}
              disabled={!canAnnotate}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="d-notes">
              <Textarea
                id="d-notes"
                name="notes"
                defaultValue={p.entry.notes ?? ""}
                maxLength={5000}
                disabled={!canAnnotate}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <TagPicker tags={p.tags} selected={p.tagIds} disabled={!canAnnotate} />
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            {canAnnotate ? <SubmitButton>Save changes</SubmitButton> : null}
            {p.level === "read_only" ? (
              <span className="text-xs text-muted-foreground">
                Read-only access — you can view this transaction but not edit it.
              </span>
            ) : !canCore && p.level === "read_write" ? (
              <span className="text-xs text-muted-foreground">
                You can edit category, merchant and notes only.
              </span>
            ) : isLinked ? (
              <span className="text-xs text-muted-foreground">
                Linked transfer: date and amount are locked, but notes, merchant, category and tags
                can still be edited.
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      <div className="space-y-6">
        <Card>
          <h2 className="mb-2 text-base font-medium text-primary">Transfer</h2>
          {p.transferId ? (
            <>
              <p className="text-sm">
                Linked with <strong>{p.transferPartnerName}</strong>.
              </p>
              {canCore ? (
                <div className="mt-3">
                  <ConfirmDialog
                    trigger={
                      <span className="inline-flex rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium">
                        Unlink transfer
                      </span>
                    }
                    title="Unlink this transfer??"
                    description="Both transactions stay in their accounts. They will no longer be treated as a pair."
                    confirmLabel="Unlink"
                    variant="secondary"
                    action={unlinkTransferAction}
                  >
                    <input type="hidden" name="transferId" value={p.transferId} />
                    <input type="hidden" name="entryId" value={p.entry.id} />
                  </ConfirmDialog>
                </div>
              ) : null}
            </>
          ) : canCore ? (
            <SuggestTransfer
              entryId={p.entry.id}
              amountMinor={p.entry.amountMinor}
              suggestions={p.suggestions}
              linkState={linkState?.ok === false ? linkState.error : undefined}
              linkAction={linkAction}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              You do not have permission to link a transfer.
            </p>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-base font-medium text-primary">Split</h2>
          {p.parentId ? (
            <p className="text-sm text-muted-foreground">
              This is part of a split.{" "}
              <Link href={`/transactions/${p.parentId}`} className="text-primary hover:underline">
                Open original transaction
              </Link>
            </p>
          ) : p.splits.length > 0 ? (
            <>
              <ul className="divide-y divide-border text-sm">
                {p.splits.map((c) => (
                  <li key={c.id} className="flex justify-between py-2">
                    <Link href={`/transactions/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                    <span className="tabular font-medium">
                      {privacy
                        ? "•••••"
                        : minorToDecimal(Math.abs(c.amountMinor), p.entry.currency)}
                    </span>
                  </li>
                ))}
              </ul>
              {canCore ? (
                <div className="mt-3">
                  <ConfirmDialog
                    trigger={
                      <span className="inline-flex rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium">
                        Unsplit transaction
                      </span>
                    }
                    title="Recombine these split transactions?"
                    description="The split parts will be removed and their total returned to this single transaction."
                    confirmLabel="Unsplit"
                    variant="secondary"
                    action={unsplitEntryAction}
                  >
                    <input type="hidden" name="parentEntryId" value={p.entry.id} />
                  </ConfirmDialog>
                </div>
              ) : null}
            </>
          ) : canCore && !p.transferId ? (
            <Dialog
              trigger={
                <span className="inline-flex rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium">
                  Split into multiple items
                </span>
              }
              title="Split transaction"
              description="Divide this transaction across multiple categories or descriptions."
              width="max-w-2xl"
            >
              <SplitForm
                parentEntryId={p.entry.id}
                totalMinor={p.entry.amountMinor}
                currency={p.entry.currency}
                categories={p.categories}
              />
            </Dialog>
          ) : (
            <p className="text-sm text-muted-foreground">
              {p.transferId
                ? "Unlink the transfer before splitting."
                : "Only full-control access can split."}
            </p>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-base font-medium text-destructive">Danger zone</h2>
          {p.level === "full_control" ? (
            <ConfirmDialog
              trigger={
                <span className="inline-flex rounded-lg bg-destructive px-3.5 py-2 text-sm font-medium text-white">
                  Delete transaction
                </span>
              }
              title="Delete this transaction?"
              description="This permanently removes the transaction. This cannot be undone."
              confirmLabel="Delete transaction"
              action={deleteEntryAction}
            >
              <input type="hidden" name="entryId" value={p.entry.id} />
            </ConfirmDialog>
          ) : (
            <SubmitButton variant="destructive" disabled>
              Delete transaction
            </SubmitButton>
          )}
        </Card>
      </div>
    </div>
  );
}

function SuggestTransfer({
  entryId,
  amountMinor,
  suggestions,
  linkState,
  linkAction
}: {
  entryId: string;
  amountMinor: number;
  suggestions: DetailProps["suggestions"];
  linkState?: string;
  linkAction: (fd: FormData) => void;
}) {
  const currentIsOutflow = amountMinor > 0;
  return (
    <div className="space-y-3">
      {linkState ? <Alert title={linkState} tone="destructive" /> : null}
      <p className="text-sm text-muted-foreground">
        Found a matching opposite-side transaction? Link them as one transfer.
      </p>
      {suggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No nearby candidates within ±4 days.</p>
      ) : (
        <ul className="divide-y divide-border">
          {suggestions.slice(0, 5).map((s) => (
            <li key={s.entryId} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 truncate">
                {s.name}
                <span className="block text-xs text-muted-foreground">{s.accountName}</span>
              </span>
              <form action={linkAction} className="shrink-0">
                <input
                  type="hidden"
                  name="outflowEntryId"
                  value={currentIsOutflow ? entryId : s.entryId}
                />
                <input
                  type="hidden"
                  name="inflowEntryId"
                  value={currentIsOutflow ? s.entryId : entryId}
                />
                <SubmitButton variant="secondary">Link</SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SplitForm({
  parentEntryId,
  totalMinor,
  currency,
  categories
}: {
  parentEntryId: string;
  totalMinor: number;
  currency: string;
  categories: { id: string; name: string }[];
}) {
  const privacy = usePrivacy();
  const [state, action] = useActionState(splitEntryAction, undefined);
  const [rows, setRows] = useState([
    { amountText: "", name: "", categoryId: "" },
    { amountText: "", name: "", categoryId: "" }
  ]);

  const sign = totalMinor < 0 ? -1 : 1;
  // Amounts are kept as raw text while typing: intermediate input such as
  // "-", "" or an over-precise fraction is a validation state (inline error,
  // submit disabled), never an exception from the change handler.
  const parsedAmounts = rows.map((row) => tryParseAmountToMinor(row.amountText, currency));
  const invalidAmounts = rows.map(
    (row, i) => row.amountText.trim() !== "" && parsedAmounts[i] === null
  );
  const parts = parsedAmounts.map((amount) => (amount ?? 0) * sign);
  const sum = parts.reduce((a, b) => a + b, 0);
  const remaining = totalMinor - sum;
  const canSubmit = parsedAmounts.every((amount) => amount !== null) && remaining === 0;

  return (
    <form action={action} className="space-y-4">
      <input
        type="hidden"
        name="payload"
        value={JSON.stringify({
          parentEntryId,
          parts: rows.map((row, i) => ({
            amountLedgerMinor: parts[i],
            name: row.name.trim() || undefined,
            categoryId: row.categoryId || null
          }))
        })}
      />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <p className="text-sm text-muted-foreground">
        Parts must add up to the full original amount. Remaining:{" "}
        <strong className="tabular">
          {privacy ? "•••••" : minorToDecimal(Math.abs(remaining), currency)}
        </strong>
      </p>
      {rows.map((row, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-3">
          <Field
            label={`Part ${i + 1} amount`}
            htmlFor={`part-${i}`}
            error={invalidAmounts[i] ? "Enter a valid amount." : undefined}
          >
            <Input
              id={`part-${i}`}
              type="text"
              inputMode="decimal"
              required
              aria-invalid={invalidAmounts[i] || undefined}
              value={row.amountText}
              onChange={(e) => {
                const amountText = e.target.value;
                setRows((prev) =>
                  prev.map((old, idx) => (idx === i ? { ...old, amountText } : old))
                );
              }}
            />
          </Field>
          <Field label="Name" htmlFor={`part-name-${i}`}>
            <Input
              id={`part-name-${i}`}
              maxLength={240}
              value={row.name}
              onChange={(e) => {
                const name = e.target.value;
                setRows((prev) => prev.map((old, idx) => (idx === i ? { ...old, name } : old)));
              }}
            />
          </Field>
          <Field label="Category" htmlFor={`part-category-${i}`}>
            <Select
              id={`part-category-${i}`}
              value={row.categoryId}
              onChange={(e) => {
                const cat = e.target.value;
                setRows((prev) =>
                  prev.map((old, idx) => (idx === i ? { ...old, categoryId: cat } : old))
                );
              }}
            >
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { amountText: "", name: "", categoryId: "" }])}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
        >
          Add another part
        </button>
        <SubmitButton disabled={!canSubmit}>Create split</SubmitButton>
      </div>
    </form>
  );
}
