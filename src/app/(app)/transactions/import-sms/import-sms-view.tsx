"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { previewSmsImportAction, confirmSmsImportAction } from "./actions";
import { Card, Badge } from "@/components/ds/card";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { fmtMoney } from "@/lib/format";
import { minorToDecimal } from "@/lib/money";
import type { SmsImportPreview } from "@/server/domain/sms-import";

const MATCH_LABELS: Record<string, string> = {
  explicit_id: "Selected account",
  account_number: "Account digits",
  institution: "Bank name",
  account_name: "Account name",
  sender: "Sender",
  text_mention: "Mentioned in SMS",
  fallback_default: "Default account"
};

export type ImportAccount = {
  id: string;
  name: string;
  currency: string;
  institution: string | null;
};

export function ImportSmsView({
  accounts,
  categories
}: {
  accounts: ImportAccount[];
  categories: { id: string; name: string }[];
}) {
  const [previewState, previewAction, previewPending] = useActionState(
    previewSmsImportAction,
    undefined
  );
  const [rawSms, setRawSms] = useState("");
  const [sender, setSender] = useState("");
  // The inputs the current preview was parsed from. The preview (and its
  // confirm form) only describe one SMS, so once the text or sender is
  // edited the preview is stale: showing it would let the confirm form
  // submit the edited SMS together with the old preview's values.
  const [previewInputs, setPreviewInputs] = useState<{
    rawSms: string;
    sender: string;
  } | null>(null);
  const preview = previewState?.ok ? previewState.data : null;
  const previewStale =
    preview !== null &&
    (previewInputs === null || previewInputs.rawSms !== rawSms || previewInputs.sender !== sender);

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Paste the SMS</h2>
        <form
          action={previewAction}
          onSubmit={() => setPreviewInputs({ rawSms, sender })}
          className="space-y-3"
        >
          <Field label="SMS text">
            <textarea
              name="rawSms"
              rows={4}
              required
              value={rawSms}
              onChange={(e) => setRawSms(e.target.value)}
              placeholder="Paste the bank or wallet SMS here…"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] focus:border-primary focus:ring-4 focus:ring-primary/10"
            />
          </Field>
          <Field label="Sender (optional — e.g. NABIL, SBL, eSewa)">
            <Input
              name="sender"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              placeholder="Leave blank if unknown"
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            The SMS never leaves this page until you confirm — parsing happens on the server, and
            nothing is recorded until you tap “Record transaction”.
          </p>
          <FormError message={previewState?.ok === false ? previewState.error : undefined} />
          <SubmitButton>Parse SMS</SubmitButton>
        </form>
      </Card>

      {preview && !previewStale && !previewPending ? (
        <PreviewCard
          key={preview.parsed.referenceId ?? "preview"}
          preview={preview}
          accounts={accounts}
          categories={categories}
          rawSms={rawSms}
          sender={sender}
        />
      ) : null}
      {preview && previewStale ? (
        <Card>
          <p className="text-sm font-medium">The SMS text changed since this preview.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The preview below no longer describes the text above, so the record button is hidden
            until you parse again.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

function PreviewCard({
  preview,
  accounts,
  categories,
  rawSms,
  sender
}: {
  preview: SmsImportPreview;
  accounts: ImportAccount[];
  categories: { id: string; name: string }[];
  rawSms: string;
  sender: string;
}) {
  const { parsed, account, suggestedCategory, duplicateEntryId, currencyMismatch } = preview;

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-primary">Parsed SMS</h2>
          <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">
            {fmtMoney(parsed.amountMinor, parsed.currency)}
          </p>
          <p className="text-sm text-muted-foreground">
            {parsed.kind === "expense" ? "Expense" : "Income"} · {parsed.date}
            {parsed.dateExplicit ? "" : " (today — the SMS carried no date)"}
            {parsed.bankName ? ` · ${parsed.bankName}` : ""}
          </p>
        </div>
        <Badge tone={parsed.kind === "expense" ? "warning" : "success"}>
          {parsed.kind === "expense" ? "Money out" : "Money in"}
        </Badge>
      </div>

      {parsed.remarks ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Details: </span>
          {parsed.remarks}
        </p>
      ) : null}
      {parsed.referenceId ? (
        <p className="truncate text-xs text-muted-foreground">Reference: {parsed.referenceId}</p>
      ) : null}

      <div className="space-y-1 text-sm">
        <p>
          <span className="text-muted-foreground">Account: </span>
          {account ? (
            <>
              <strong>{account.name}</strong>
              {account.institution ? ` (${account.institution})` : ""} · matched by{" "}
              {MATCH_LABELS[account.matchedBy] ?? account.matchedBy}
            </>
          ) : (
            "No account matched — pick one below."
          )}
        </p>
        <p>
          <span className="text-muted-foreground">Category: </span>
          {suggestedCategory ? (
            <>
              <strong>{suggestedCategory.name}</strong> (used {suggestedCategory.useCount}{" "}
              {suggestedCategory.useCount === 1 ? "time" : "times"} for this payee — you can change
              it below)
            </>
          ) : (
            "No suggestion from your history — pick one below."
          )}
        </p>
      </div>

      {currencyMismatch && account ? (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
          The SMS is in {parsed.currency} but {account.name} is in {account.currency}. The amount
          below is in {account.currency} — adjust it if the conversion differs.
        </p>
      ) : null}

      {duplicateEntryId ? (
        <div className="rounded-md border border-border px-3 py-2 text-sm">
          <p className="font-medium">This SMS is already recorded.</p>
          <p className="text-muted-foreground">
            The same reference was imported before, so nothing new will be created.{" "}
            <Link
              href={`/transactions/${duplicateEntryId}`}
              className="font-medium text-primary hover:underline"
            >
              View the recorded transaction
            </Link>
          </p>
        </div>
      ) : (
        <ConfirmForm
          preview={preview}
          accounts={accounts}
          categories={categories}
          rawSms={rawSms}
          sender={sender}
        />
      )}
    </Card>
  );
}

function ConfirmForm({
  preview,
  accounts,
  categories,
  rawSms,
  sender
}: {
  preview: SmsImportPreview;
  accounts: ImportAccount[];
  categories: { id: string; name: string }[];
  rawSms: string;
  sender: string;
}) {
  const [confirmState, confirmAction] = useActionState(confirmSmsImportAction, undefined);
  const [accountId, setAccountId] = useState(preview.account?.id ?? "");
  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? preview.parsed.currency;
  const { parsed } = preview;

  if (confirmState?.ok && confirmState.data) {
    const { entryId, duplicated } = confirmState.data;
    return (
      <div className="rounded-md border border-border px-3 py-2 text-sm">
        <p className="font-medium">
          {duplicated ? "Already recorded — no duplicate created." : "Transaction recorded."}
        </p>
        <p className="text-muted-foreground">
          <Link
            href={`/transactions/${entryId}`}
            className="font-medium text-primary hover:underline"
          >
            View the transaction
          </Link>{" "}
          or paste another SMS above.
        </p>
      </div>
    );
  }

  return (
    <form action={confirmAction} className="space-y-3 border-t border-border pt-4">
      <input type="hidden" name="rawSms" value={rawSms} />
      <input type="hidden" name="sender" value={sender} />
      <h3 className="text-sm font-medium">Confirm and record</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account">
          <Select
            name="accountId"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            <option value="">Choose an account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency}){a.institution ? ` — ${a.institution}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <Select name="categoryId" defaultValue={preview.suggestedCategory?.id ?? ""}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Description">
          <Input name="name" defaultValue={parsed.remarks ?? parsed.merchant ?? ""} required />
        </Field>
        <Field label="Payee">
          <Input name="merchant" defaultValue={parsed.merchant ?? ""} />
        </Field>
        <Field label="Date">
          <Input name="date" type="date" defaultValue={parsed.date} required />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Amount (${currency})`}>
          <Input
            name="amount"
            inputMode="decimal"
            defaultValue={minorToDecimal(parsed.amountMinor, parsed.currency)}
            required
          />
        </Field>
        <p className="self-end text-xs text-muted-foreground">
          The amount is recorded in the account&apos;s currency
          {preview.currencyMismatch
            ? ` — the SMS was in ${parsed.currency}, so check the converted amount`
            : ""}
          .
        </p>
      </div>
      <FormError message={confirmState?.ok === false ? confirmState.error : undefined} />
      <SubmitButton>Record transaction</SubmitButton>
    </form>
  );
}
