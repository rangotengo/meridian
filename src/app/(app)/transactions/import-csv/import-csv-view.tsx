"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import {
  confirmStatementCsvAction,
  parseStatementCsvAction,
  previewStatementCsvAction
} from "./actions";
import { Alert, Card } from "@/components/ds/card";
import { Field, FormError, Textarea } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { fmtMoney, pluralize } from "@/lib/format";
import type { StatementMapping } from "@/server/domain/statement-csv";

type AccountOption = { id: string; name: string; currency: string };

function MappingSelect({
  label,
  name,
  headers,
  value,
  onChange
}: {
  label: string;
  name: string;
  headers: string[];
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <Field label={label} htmlFor={`map-${name}`}>
      <select
        id={`map-${name}`}
        name={`map_${name}`}
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm"
      >
        <option value="">— none —</option>
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ImportCsvView({ accounts }: { accounts: AccountOption[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [csvText, setCsvText] = useState("");
  const [parsedText, setParsedText] = useState("");
  // The mapping starts as the server-detected one and becomes a local
  // override once the user changes a column. A new parse clears the
  // override in the submit handler, so no effect is needed to sync them.
  const [mappingOverride, setMappingOverride] = useState<StatementMapping | null>(null);
  // A preview is only valid for the exact parse + mapping it was computed
  // from. These epochs hide stale server state: a new parse invalidates the
  // old preview, changing any mapping select invalidates the preview until
  // it is re-run, and Start over hides the parsed/preview cards even though
  // useActionState state cannot be cleared from the client.
  const [parseEpoch, setParseEpoch] = useState(0);
  const [parsedEpoch, setParsedEpoch] = useState(-1);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [previewShownEpoch, setPreviewShownEpoch] = useState(-1);
  const fileRef = useRef<HTMLInputElement>(null);

  const [parseState, parseAction] = useActionState(parseStatementCsvAction, undefined);
  const [previewState, previewAction] = useActionState(previewStatementCsvAction, undefined);
  const [confirmState, confirmAction] = useActionState(confirmStatementCsvAction, undefined);

  const parsed = parseState?.ok ? parseState.data : undefined;
  const preview = previewState?.ok ? previewState.data : undefined;
  const result = confirmState?.ok ? confirmState.data : undefined;
  const account = accounts.find((a) => a.id === accountId);
  const mapping = mappingOverride ?? parsed?.mapping ?? null;

  function updateMapping(patch: Partial<StatementMapping>) {
    if (!mapping) return;
    // The visible preview was computed from the old mapping: hide it (and
    // its Import button) until the user previews again.
    setPreviewEpoch((e) => e + 1);
    setMappingOverride({ ...mapping, ...patch });
  }

  function reset() {
    setCsvText("");
    setParsedText("");
    setMappingOverride(null);
    // parseState/previewState cannot be cleared from the client, so bump
    // both epochs: the parsed and preview cards stop rendering.
    setParseEpoch((e) => e + 1);
    setPreviewEpoch((e) => e + 1);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onFileChosen(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  if (accounts.length === 0) {
    return <Alert title="No accounts yet">Add an account first, then import its statement.</Alert>;
  }

  if (result) {
    return (
      <Card className="space-y-3 p-4">
        <p className="font-medium">Import complete.</p>
        <p className="text-sm text-muted-foreground">
          Imported {pluralize(result.imported, "transaction")}; skipped {result.skippedDuplicates}{" "}
          duplicate{result.skippedDuplicates === 1 ? "" : "s"} and {result.skippedErrors} row
          {result.skippedErrors === 1 ? "" : "s"} with errors, out of {result.totalRows} rows.
        </p>
        <div className="flex gap-3">
          <Link
            href="/transactions"
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            View transactions
          </Link>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            Import another file
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <Field label="Account" htmlFor="account">
          <select
            id="account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={Boolean(parsed) && parsedEpoch === parseEpoch}
            className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm disabled:opacity-50"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">
          Amounts are read in the account&apos;s currency ({account?.currency ?? "—"}). The
          statement&apos;s own currency column, if any, is ignored.
        </p>
        <form
          action={(formData) => {
            setMappingOverride(null);
            setParsedText(csvText);
            const nextParse = parseEpoch + 1;
            setParseEpoch(nextParse);
            setParsedEpoch(nextParse);
            setPreviewEpoch((e) => e + 1);
            parseAction(formData);
          }}
          className="space-y-3"
        >
          <input type="hidden" name="csvText" value={csvText} />
          <Field label="Statement file" htmlFor="csv-file">
            <input
              id="csv-file"
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onFileChosen(e.target.files?.[0])}
              className="block w-full cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-surface-inset file:px-2 file:py-1 file:text-sm file:font-medium hover:file:bg-surface-hover"
            />
          </Field>
          <Field label="Or paste the CSV" htmlFor="csv-text">
            <Textarea
              id="csv-text"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={8}
              placeholder={
                "Date,Particulars,Debit,Credit,Balance\n2026-11-01,ATM Withdrawal,5000,,"
              }
            />
          </Field>
          <FormError message={!parseState?.ok ? parseState?.error : undefined} />
          <div className="flex gap-2">
            <SubmitButton>Parse statement</SubmitButton>
            {parsed && parsedEpoch === parseEpoch ? (
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium"
              >
                Start over
              </button>
            ) : null}
          </div>
        </form>
        {parsed && parsedEpoch === parseEpoch ? (
          <p className="text-sm text-muted-foreground">
            Found {parsed.headers.length} columns and {parsed.rowCount} rows. Columns were detected
            automatically — correct them below if needed.
          </p>
        ) : null}
      </Card>

      {parsed && mapping && parsedEpoch === parseEpoch ? (
        <Card className="space-y-4 p-4">
          <form
            action={(formData) => {
              const nextPreview = previewEpoch + 1;
              setPreviewEpoch(nextPreview);
              setPreviewShownEpoch(nextPreview);
              previewAction(formData);
            }}
            className="space-y-3"
          >
            <input type="hidden" name="accountId" value={accountId} />
            <input type="hidden" name="csvText" value={parsedText} />
            <div className="grid gap-3 sm:grid-cols-2">
              <MappingSelect
                label="Date column"
                name="date"
                headers={parsed.headers}
                value={mapping.date}
                onChange={(v) => updateMapping({ date: v })}
              />
              <MappingSelect
                label="Description column"
                name="description"
                headers={parsed.headers}
                value={mapping.description}
                onChange={(v) => updateMapping({ description: v })}
              />
              <MappingSelect
                label="Amount column (single, signed)"
                name="amount"
                headers={parsed.headers}
                value={mapping.amount}
                onChange={(v) => updateMapping({ amount: v })}
              />
              <MappingSelect
                label="Debit column"
                name="debit"
                headers={parsed.headers}
                value={mapping.debit}
                onChange={(v) => updateMapping({ debit: v })}
              />
              <MappingSelect
                label="Credit column"
                name="credit"
                headers={parsed.headers}
                value={mapping.credit}
                onChange={(v) => updateMapping({ credit: v })}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Use either one signed amount column (negative means money out) or debit + credit
              columns — not both.
            </p>
            <FormError message={!previewState?.ok ? previewState?.error : undefined} />
            <SubmitButton>Preview import</SubmitButton>
          </form>
          {preview && previewShownEpoch !== previewEpoch ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              The preview is out of date — run Preview import again to see the updated rows before
              importing.
            </p>
          ) : null}
        </Card>
      ) : null}

      {preview && account && previewShownEpoch === previewEpoch && parsedEpoch === parseEpoch ? (
        <Card className="space-y-4 p-4">
          <p className="text-sm">
            <strong>{preview.importableCount}</strong> ready to import,{" "}
            <strong>{preview.duplicateCount}</strong> already recorded,{" "}
            <strong>{preview.errorCount}</strong> with errors, out of {preview.totalRows} rows.
            {preview.totalRows > preview.rows.length
              ? ` Showing the first ${preview.rows.length}.`
              : ""}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2">Description</th>
                  <th className="py-2 pr-2 text-right">Amount</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-2 whitespace-nowrap">{row.date ?? "—"}</td>
                    <td className="py-2 pr-2">{row.name ?? "—"}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {row.amountLedgerMinor !== null
                        ? fmtMoney(row.amountLedgerMinor, account.currency)
                        : "—"}
                    </td>
                    <td className="py-2">
                      {row.error ? (
                        <span className="text-destructive">{row.error}</span>
                      ) : row.duplicate ? (
                        row.duplicateEntryId ? (
                          <Link
                            href={`/transactions/${row.duplicateEntryId}`}
                            className="text-muted-foreground underline underline-offset-2"
                          >
                            Already recorded
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Duplicate in file</span>
                        )
                      ) : (
                        <span className="text-success">Ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form action={confirmAction}>
            <input type="hidden" name="accountId" value={accountId} />
            <input type="hidden" name="csvText" value={parsedText} />
            <input type="hidden" name="map_date" value={mapping?.date ?? ""} />
            <input type="hidden" name="map_description" value={mapping?.description ?? ""} />
            <input type="hidden" name="map_amount" value={mapping?.amount ?? ""} />
            <input type="hidden" name="map_debit" value={mapping?.debit ?? ""} />
            <input type="hidden" name="map_credit" value={mapping?.credit ?? ""} />
            <FormError message={!confirmState?.ok ? confirmState?.error : undefined} />
            <SubmitButton disabled={preview.importableCount === 0}>
              Import {preview.importableCount}{" "}
              {preview.importableCount === 1 ? "transaction" : "transactions"}
            </SubmitButton>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
