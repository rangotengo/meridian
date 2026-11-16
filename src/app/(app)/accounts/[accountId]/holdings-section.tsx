"use client";

import { useActionState } from "react";
import {
  addHoldingAction,
  adjustHoldingAction,
  deleteHoldingAction,
  importHoldingsCsvAction,
  updateHoldingAction
} from "@/app/(app)/actions";
import { Card } from "@/components/ds/card";
import { ConfirmDialog, Dialog, useDialogClose } from "@/components/ds/dialog";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { Amount } from "@/components/finance/amount";
import { minorToDecimal } from "@/lib/money";
import type { HoldingsSummary } from "@/server/domain/holdings";

export type HoldingView = {
  id: string;
  ticker: string;
  companyName: string | null;
  quantity: string;
  averageCostMinor: number | null;
  currentPriceMinor: number | null;
  valueMinor: number;
  gainMinor: number | null;
};

export function HoldingsSection({
  accountId,
  currency,
  canManage,
  holdings,
  summary,
  masked
}: {
  accountId: string;
  currency: string;
  canManage: boolean;
  holdings: HoldingView[];
  summary: HoldingsSummary;
  masked: boolean;
}) {
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium text-primary">Holdings</h2>
        {canManage ? (
          <span className="flex items-center gap-4">
            <Dialog
              title="Add holding"
              description="Record a stock position you hold. The account value updates to the portfolio total."
              trigger={
                <span className="text-sm font-medium text-accent hover:underline">Add holding</span>
              }
            >
              <AddHoldingForm accountId={accountId} currency={currency} />
            </Dialog>
            <Dialog
              title="Import holdings from CSV"
              description="Header row required: ticker, quantity, average_cost, current_price, company_name (optional). Prices are in major units. Existing tickers are updated."
              trigger={
                <span className="text-sm font-medium text-accent hover:underline">Import CSV</span>
              }
            >
              <ImportCsvForm accountId={accountId} />
            </Dialog>
          </span>
        ) : null}
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No holdings recorded yet.
          {canManage
            ? " Add one manually or import a CSV — this account's value will then be managed by its holdings."
            : ""}
        </p>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <SummaryStat
              label="Total value"
              minor={summary.totalValueMinor}
              currency={currency}
              masked={masked}
            />
            <SummaryStat
              label="Total cost"
              minor={summary.totalCostMinor}
              currency={currency}
              masked={masked}
              emptyText="Unknown"
            />
            <div>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">
                Unrealized gain/loss
              </p>
              {summary.unrealizedGainMinor === null ? (
                <p className="tabular mt-0.5 text-lg font-semibold">—</p>
              ) : (
                <p className="mt-0.5 flex items-baseline gap-2">
                  <Amount
                    minor={summary.unrealizedGainMinor}
                    currency={currency}
                    masked={masked}
                    signed
                    colorize
                    className="text-lg font-semibold"
                  />
                  {summary.unrealizedGainPercent !== null ? (
                    <span className="text-sm text-muted-foreground">
                      ({summary.unrealizedGainPercent >= 0 ? "+" : ""}
                      {summary.unrealizedGainPercent.toFixed(2)}%)
                    </span>
                  ) : null}
                </p>
              )}
            </div>
          </div>
          {summary.partialCost ? (
            <p className="mb-3 text-xs text-muted-foreground">
              Some holdings have no average cost recorded, so the cost total and gain/loss cover
              only the holdings with known cost.
            </p>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="py-2 font-medium">
                    Ticker
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Avg cost
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Current price
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Value
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Gain/loss
                  </th>
                  {canManage ? (
                    <th scope="col" className="py-2 text-right font-medium">
                      Actions
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holdings.map((h) => (
                  <tr key={h.id}>
                    <td className="py-2.5">
                      <span className="font-medium">{h.ticker}</span>
                      {h.companyName ? (
                        <span className="block text-xs text-muted-foreground">{h.companyName}</span>
                      ) : null}
                    </td>
                    <td className="tabular py-2.5 text-right">{h.quantity}</td>
                    <td className="py-2.5 text-right">
                      {h.averageCostMinor === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Amount minor={h.averageCostMinor} currency={currency} masked={masked} />
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {h.currentPriceMinor === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Amount minor={h.currentPriceMinor} currency={currency} masked={masked} />
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      <Amount minor={h.valueMinor} currency={currency} masked={masked} />
                    </td>
                    <td className="py-2.5 text-right">
                      {h.gainMinor === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Amount
                          minor={h.gainMinor}
                          currency={currency}
                          masked={masked}
                          signed
                          colorize
                        />
                      )}
                    </td>
                    {canManage ? (
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <HoldingRowActions accountId={accountId} currency={currency} holding={h} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function SummaryStat({
  label,
  minor,
  currency,
  masked,
  emptyText
}: {
  label: string;
  minor: number | null;
  currency: string;
  masked: boolean;
  emptyText?: string;
}) {
  return (
    <div>
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      {minor === null ? (
        <p className="tabular mt-0.5 text-lg font-semibold">{emptyText ?? "—"}</p>
      ) : (
        <Amount
          minor={minor}
          currency={currency}
          masked={masked}
          className="mt-0.5 block text-lg font-semibold"
        />
      )}
    </div>
  );
}

function HoldingRowActions({
  accountId,
  currency,
  holding
}: {
  accountId: string;
  currency: string;
  holding: HoldingView;
}) {
  return (
    <span className="flex items-center justify-end gap-3">
      <Dialog
        title={`Edit ${holding.ticker}`}
        description="Correct the position. The account value updates to the portfolio total."
        trigger={<span className="font-medium text-accent hover:underline">Edit</span>}
      >
        <EditHoldingForm accountId={accountId} currency={currency} holding={holding} />
      </Dialog>
      <Dialog
        title={`Buy or sell ${holding.ticker}`}
        description="A buy updates the average cost to the weighted average; a sell keeps the average cost unchanged. Selling the full quantity removes the holding."
        trigger={<span className="font-medium text-accent hover:underline">Buy/Sell</span>}
      >
        <AdjustHoldingForm accountId={accountId} currency={currency} holding={holding} />
      </Dialog>
      <ConfirmDialog
        title={`Delete ${holding.ticker}?`}
        description="The position is removed and the account value is recalculated from the remaining holdings."
        confirmLabel="Delete holding"
        action={deleteHoldingAction}
        trigger={<span className="font-medium text-danger hover:underline">Delete</span>}
      >
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="holdingId" value={holding.id} />
      </ConfirmDialog>
    </span>
  );
}

function PriceFields({
  currency,
  averageCostMinor,
  currentPriceMinor,
  idPrefix
}: {
  currency: string;
  averageCostMinor: number | null;
  currentPriceMinor: number | null;
  idPrefix: string;
}) {
  return (
    <>
      <Field label={`Average cost (${currency})`} htmlFor={`${idPrefix}-avg`}>
        <Input
          id={`${idPrefix}-avg`}
          name="averageCost"
          inputMode="decimal"
          placeholder="Optional"
          defaultValue={averageCostMinor === null ? "" : minorToDecimal(averageCostMinor, currency)}
        />
      </Field>
      <Field label={`Current price (${currency})`} htmlFor={`${idPrefix}-price`}>
        <Input
          id={`${idPrefix}-price`}
          name="currentPrice"
          inputMode="decimal"
          placeholder="Optional"
          defaultValue={
            currentPriceMinor === null ? "" : minorToDecimal(currentPriceMinor, currency)
          }
        />
      </Field>
    </>
  );
}

function FormButtons({ submitLabel, saved }: { submitLabel: string; saved: boolean }) {
  const close = useDialogClose();
  return (
    <>
      {saved ? <p className="text-sm text-success">Saved.</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={close}
          className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
        >
          Cancel
        </button>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </>
  );
}

function AddHoldingForm({ accountId, currency }: { accountId: string; currency: string }) {
  const [state, action] = useActionState(addHoldingAction, undefined);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="accountId" value={accountId} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Ticker" htmlFor="holding-add-ticker">
        <Input id="holding-add-ticker" name="ticker" placeholder="e.g. NABIL" required />
      </Field>
      <Field label="Company name" htmlFor="holding-add-company">
        <Input id="holding-add-company" name="companyName" placeholder="Optional" />
      </Field>
      <Field label="Quantity" htmlFor="holding-add-qty">
        <Input id="holding-add-qty" name="quantity" inputMode="decimal" required />
      </Field>
      <PriceFields
        currency={currency}
        averageCostMinor={null}
        currentPriceMinor={null}
        idPrefix="holding-add"
      />
      <FormButtons submitLabel="Add holding" saved={state?.ok === true} />
    </form>
  );
}

function EditHoldingForm({
  accountId,
  currency,
  holding
}: {
  accountId: string;
  currency: string;
  holding: HoldingView;
}) {
  const [state, action] = useActionState(updateHoldingAction, undefined);
  const prefix = `holding-edit-${holding.id}`;
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="holdingId" value={holding.id} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Company name" htmlFor={`${prefix}-company`}>
        <Input
          id={`${prefix}-company`}
          name="companyName"
          defaultValue={holding.companyName ?? ""}
          placeholder="Optional"
        />
      </Field>
      <Field label="Quantity" htmlFor={`${prefix}-qty`}>
        <Input
          id={`${prefix}-qty`}
          name="quantity"
          inputMode="decimal"
          defaultValue={holding.quantity}
          required
        />
      </Field>
      <PriceFields
        currency={currency}
        averageCostMinor={holding.averageCostMinor}
        currentPriceMinor={holding.currentPriceMinor}
        idPrefix={prefix}
      />
      <FormButtons submitLabel="Save holding" saved={state?.ok === true} />
    </form>
  );
}

function AdjustHoldingForm({
  accountId,
  currency,
  holding
}: {
  accountId: string;
  currency: string;
  holding: HoldingView;
}) {
  const [state, action] = useActionState(adjustHoldingAction, undefined);
  const prefix = `holding-adjust-${holding.id}`;
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="ticker" value={holding.ticker} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Side" htmlFor={`${prefix}-side`}>
        <Select id={`${prefix}-side`} name="side" defaultValue="buy">
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </Select>
      </Field>
      <Field label="Quantity" htmlFor={`${prefix}-qty`}>
        <Input id={`${prefix}-qty`} name="quantity" inputMode="decimal" required />
      </Field>
      <Field label={`Price per share (${currency})`} htmlFor={`${prefix}-price`}>
        <Input id={`${prefix}-price`} name="price" inputMode="decimal" required />
      </Field>
      <FormButtons submitLabel="Record trade" saved={state?.ok === true} />
    </form>
  );
}

function ImportCsvForm({ accountId }: { accountId: string }) {
  const [state, action] = useActionState(importHoldingsCsvAction, undefined);
  const result = state?.ok ? state.data : undefined;
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="accountId" value={accountId} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="CSV file" htmlFor="holding-import-file">
        <Input id="holding-import-file" name="csv" type="file" accept=".csv,text/csv" required />
      </Field>
      {result ? (
        <div className="text-sm">
          <p className="text-success">
            Imported: {result.created} created, {result.updated} updated.
          </p>
          {result.errors.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-danger">
              {result.errors.map((e) => (
                <li key={e.row}>
                  Row {e.row}: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <FormButtons submitLabel="Import holdings" saved={false} />
    </form>
  );
}
