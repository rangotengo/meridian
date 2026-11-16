"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createTransactionAction,
  createTransactionDialogAction,
  createTransferAction,
  createTransferDialogAction
} from "@/app/(app)/actions";
import { Dialog, useDialogClose } from "@/components/ds/dialog";
import { Card, Alert } from "@/components/ds/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { TagPicker } from "@/components/ds/tag-picker";
import {
  compatibleDestinations,
  type ComposerAccountOption,
  type ComposerMode,
  type ComposerOption
} from "@/lib/transaction-composer";

export type Option = ComposerOption;
export type AccountOption = ComposerAccountOption;

export type TransactionComposerProps = {
  /** Accounts the actor may create entries on (active, full control). */
  accounts: AccountOption[];
  categories: Option[];
  tags: Option[];
  today: string;
  /** Validated preset account id ("" for none). A prop, never a URL read. */
  initialAccountId?: string;
  /** Mode the composer opens in; a requested transfer stays a transfer. */
  initialMode?: ComposerMode;
  /**
   * "page" submits through the redirecting actions (standalone creation
   * page); "dialog" submits through the typed-result actions and reports
   * success via onSuccess instead of navigating.
   */
  variant?: "page" | "dialog";
  /** Prefix for every field id, unique per composer instance on a page. */
  idPrefix: string;
  /** Dialog variant: called after a successful save. */
  onSuccess?: () => void;
  /** Dialog variant: renders a Cancel button wired to this handler. */
  onCancel?: () => void;
};

const MODES: readonly ComposerMode[] = ["expense", "income", "transfer"];

/**
 * React resets form fields in the DOM when a form action resolves, and
 * controlled fields are only re-applied from state on the NEXT render —
 * so right after a { ok: false } result, some controls (a select, the
 * tag checkboxes) can visibly snap back to their defaults even though
 * their state still holds the draft. Force one extra render when a
 * failure result lands so every controlled field is re-synced from
 * state. The render must be scheduled after the error commit (React's
 * reset lands after a same-commit re-render, which is why this defers
 * by one frame instead of adjusting state during render). Verified
 * against React 19: a post-error re-render heals the desynced controls.
 */
function useDraftResyncOnError(state: { ok: boolean } | undefined) {
  const [, setResyncTick] = useState(0);
  const seenState = useRef(state);
  useEffect(() => {
    if (seenState.current === state) return;
    seenState.current = state;
    if (state?.ok !== false) return;
    const frame = requestAnimationFrame(() => setResyncTick((t) => t + 1));
    return () => cancelAnimationFrame(frame);
  }, [state]);
}

export function TransactionComposer({
  accounts,
  categories,
  tags,
  today,
  initialAccountId = "",
  initialMode = "expense",
  variant = "page",
  idPrefix,
  onSuccess,
  onCancel
}: TransactionComposerProps) {
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  const preset = accounts.some((a) => a.id === initialAccountId) ? initialAccountId : "";

  return (
    <>
      <div
        role="tablist"
        aria-label="Transaction type"
        className="flex max-w-fit gap-1 rounded-lg bg-surface-inset p-1"
      >
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors ${
              mode === m ? "bg-surface text-primary shadow-sm" : "text-muted hover:bg-surface-hover"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {accounts.length === 0 ? (
        <Alert title="Add an account first">
          You need one account to record transactions and two to move money between them.
        </Alert>
      ) : mode === "transfer" ? (
        <TransferForm
          accounts={accounts}
          presetAccount={preset}
          today={today}
          idPrefix={`${idPrefix}-transfer`}
          dialog={variant === "dialog"}
          onSuccess={onSuccess}
          onCancel={onCancel}
        />
      ) : (
        <EntryForm
          mode={mode}
          accounts={accounts}
          categories={categories}
          tags={tags}
          presetAccount={preset}
          today={today}
          idPrefix={`${idPrefix}-entry`}
          dialog={variant === "dialog"}
          onSuccess={onSuccess}
          onCancel={onCancel}
        />
      )}
    </>
  );
}

function EntryForm({
  mode,
  accounts,
  categories,
  tags,
  presetAccount,
  today,
  idPrefix,
  dialog,
  onSuccess,
  onCancel
}: {
  mode: "expense" | "income";
  accounts: AccountOption[];
  categories: Option[];
  tags: Option[];
  presetAccount: string;
  today: string;
  idPrefix: string;
  dialog: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const [state, action] = useActionState(
    dialog ? createTransactionDialogAction : createTransactionAction,
    undefined
  );
  useDraftResyncOnError(state);
  useEffect(() => {
    if (dialog && state?.ok) onSuccess?.();
  }, [dialog, state, onSuccess]);

  // Every field is controlled. React resets UNCONTROLLED inputs when a
  // form action resolves — including a { ok: false } validation/domain
  // refusal — which silently erased the whole draft while the error
  // stayed on screen. Keeping the draft in state means a refusal only
  // adds the error message (useDraftResyncOnError above covers the
  // DOM/state desync React's reset leaves behind on some controls);
  // deliberate resets still happen because the dialog remounts the
  // composer on every open and the page variant redirects on success.
  const [accountId, setAccountId] = useState(presetAccount || accounts[0]?.id || "");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [entryName, setEntryName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [merchant, setMerchant] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const body = (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="kind" value={mode} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Account" htmlFor={`${idPrefix}-account`}>
        <Select
          id={`${idPrefix}-account`}
          name="accountId"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Date" htmlFor={`${idPrefix}-date`}>
        <Input
          id={`${idPrefix}-date`}
          name="date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </Field>
      <Field label="Amount" htmlFor={`${idPrefix}-amount`}>
        <Input
          id={`${idPrefix}-amount`}
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>
      <Field label="Description" htmlFor={`${idPrefix}-name`}>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          required
          maxLength={240}
          placeholder={mode === "expense" ? "Grocery run" : "Salary"}
          value={entryName}
          onChange={(e) => setEntryName(e.target.value)}
        />
      </Field>
      <Field label="Category" htmlFor={`${idPrefix}-category`}>
        <Select
          id={`${idPrefix}-category`}
          name="categoryId"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Merchant (optional)" htmlFor={`${idPrefix}-merchant`}>
        <Input
          id={`${idPrefix}-merchant`}
          name="merchant"
          maxLength={120}
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Notes (optional)" htmlFor={`${idPrefix}-notes`}>
          <Textarea
            id={`${idPrefix}-notes`}
            name="notes"
            maxLength={5000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <TagPicker tags={tags} selected={selectedTagIds} onSelectedChange={setSelectedTagIds} />
      </div>
      <div className="flex items-center gap-2 sm:col-span-2">
        <SubmitButton>Record {mode}</SubmitButton>
        {dialog ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
  return dialog ? body : <Card>{body}</Card>;
}

function TransferForm({
  accounts,
  presetAccount,
  today,
  idPrefix,
  dialog,
  onSuccess,
  onCancel
}: {
  accounts: AccountOption[];
  presetAccount: string;
  today: string;
  idPrefix: string;
  dialog: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const [state, action] = useActionState(
    dialog ? createTransferDialogAction : createTransferAction,
    undefined
  );
  useDraftResyncOnError(state);
  useEffect(() => {
    if (dialog && state?.ok) onSuccess?.();
  }, [dialog, state, onSuccess]);

  const [sourceId, setSourceId] = useState(presetAccount || accounts[0]?.id || "");
  const [destId, setDestId] = useState<string | null>(null);
  // Date/amount/note are controlled for the same reason as in EntryForm:
  // an { ok: false } action result must not reset the draft (React resets
  // uncontrolled fields when a form action resolves).
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const source = accounts.find((a) => a.id === sourceId);
  // Destination options are a function of the CURRENT source: a different
  // account in the source's currency. Recomputed on every source change.
  const destinations = compatibleDestinations(accounts, sourceId);
  const effectiveDest =
    destId && destinations.some((d) => d.id === destId) ? destId : (destinations[0]?.id ?? "");
  const noDestination = destinations.length === 0;

  const body = (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="From account" htmlFor={`${idPrefix}-from`}>
        <Select
          id={`${idPrefix}-from`}
          name="fromAccountId"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          required
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      {noDestination ? (
        <div className="sm:col-span-2">
          <Alert title="No compatible destination">
            {source
              ? `There is no other active account you control in ${source.currency} to move money to from ${source.name}. Transfers need a second account in the same currency — add one, or record this as an expense or income instead.`
              : "Transfers need a second active account in the same currency."}
          </Alert>
        </div>
      ) : (
        <Field
          label="To account"
          htmlFor={`${idPrefix}-to`}
          hint="Accounts must share the same currency."
        >
          <Select
            id={`${idPrefix}-to`}
            name="toAccountId"
            value={effectiveDest}
            onChange={(e) => setDestId(e.target.value)}
            required
          >
            {destinations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Date" htmlFor={`${idPrefix}-date`}>
        <Input
          id={`${idPrefix}-date`}
          name="date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </Field>
      <Field label="Amount" htmlFor={`${idPrefix}-amount`}>
        <Input
          id={`${idPrefix}-amount`}
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Note (optional)" htmlFor={`${idPrefix}-name`}>
          <Input
            id={`${idPrefix}-name`}
            name="name"
            maxLength={240}
            placeholder="Monthly credit card payment"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex items-center gap-2 sm:col-span-2">
        <SubmitButton disabled={noDestination}>Move money</SubmitButton>
        {dialog ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
  return dialog ? body : <Card>{body}</Card>;
}

/**
 * The composer hosted in the shared native Dialog. The composer is
 * remounted on every open (keyed by an open counter fed by Dialog's
 * onOpen), so a previous attempt's values, mode, and success/error state
 * never leak into the next open. On success the current view is refreshed
 * (re-rendering the page, its balances/activity, and the sidebar in place)
 * and the dialog closes; focus returns to the trigger via Dialog's own
 * close handling.
 */
export function TransactionComposerDialog({
  trigger,
  title,
  ...composerProps
}: {
  trigger: React.ReactNode;
  title: string;
} & Omit<TransactionComposerProps, "variant" | "onSuccess" | "onCancel">) {
  const [openCount, setOpenCount] = useState(0);
  return (
    <Dialog
      trigger={trigger}
      title={title}
      width="max-w-2xl"
      onOpen={() => setOpenCount((c) => c + 1)}
    >
      <DialogComposerBody key={openCount} {...composerProps} />
    </Dialog>
  );
}

function DialogComposerBody(
  props: Omit<TransactionComposerProps, "variant" | "onSuccess" | "onCancel">
) {
  const close = useDialogClose();
  const router = useRouter();
  const handleSuccess = () => {
    router.refresh();
    close();
  };
  return (
    <TransactionComposer {...props} variant="dialog" onSuccess={handleSuccess} onCancel={close} />
  );
}
