"use client";

import { useActionState } from "react";
import { ConfirmDialog, Dialog, useDialogClose } from "@/components/ds/dialog";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { fmtDate, fmtMoney } from "@/lib/format";
import {
  updateAccountAction,
  setAccountStatusAction,
  deleteAccountAction,
  shareAccountAction,
  switchBalanceTrackingAction
} from "@/app/(app)/accounts/actions";

type Member = { id: string; name: string; email: string };

export type TrackingPreview = {
  to: "valuation" | "transactions";
  currentBalanceMinor: number;
  resultingBalanceMinor: number;
  openingTransactionAmountMinor: number | null;
  restatedOpeningAdjustments: number;
  valuationCount: number;
  earliestValuationDate: string | null;
  meroshareLinked: boolean;
  holdingsManaged: boolean;
};

export function AccountActions({
  accountId,
  status,
  accountName,
  institution,
  includedInReports,
  members,
  balanceTracking,
  currency,
  trackingPreview
}: {
  accountId: string;
  status: string;
  accountName: string;
  institution: string | null;
  includedInReports: boolean;
  members: Member[];
  balanceTracking?: "valuation" | "transactions";
  currency?: string;
  trackingPreview?: TrackingPreview | null;
}) {
  return (
    <>
      <Dialog
        trigger={
          <span className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium">
            Edit
          </span>
        }
        title="Account settings"
      >
        <EditSettings
          accountId={accountId}
          name={accountName}
          institution={institution}
          includedInReports={includedInReports}
        />
      </Dialog>

      {trackingPreview && balanceTracking && currency ? (
        <Dialog
          trigger={
            <span className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium">
              Balance tracking
            </span>
          }
          title="Balance tracking"
          description={
            balanceTracking === "valuation"
              ? "This account's balance is its latest valuation; its transactions do not affect it."
              : "This account's balance follows its transactions; valuations do not affect it."
          }
        >
          <BalanceTrackingPanel
            accountId={accountId}
            currency={currency}
            current={balanceTracking}
            preview={trackingPreview}
          />
        </Dialog>
      ) : null}

      <Dialog
        trigger={
          <span className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium">
            Share
          </span>
        }
        title="Share with family members"
      >
        <SharePanel accountId={accountId} members={members} />
      </Dialog>

      {status === "active" ? (
        <ConfirmDialog
          trigger={
            <span className="inline-flex rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium">
              Close account
            </span>
          }
          title="Close this account?"
          description="Closed accounts keep their history but reject new transactions until you reopen them."
          confirmLabel="Close account"
          variant="secondary"
          action={setAccountStatusAction}
        >
          <input type="hidden" name="accountId" value={accountId} />
          <input type="hidden" name="status" value="disabled" />
        </ConfirmDialog>
      ) : (
        <form action={setAccountStatusAction}>
          <input type="hidden" name="accountId" value={accountId} />
          <input type="hidden" name="status" value="active" />
          <SubmitButton variant="secondary">Reopen account</SubmitButton>
        </form>
      )}

      <Dialog
        trigger={
          <span className="rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive">
            Delete
          </span>
        }
        title="Delete this account?"
        description="This permanently removes the account and every transaction in it. This cannot be undone."
      >
        <DeleteForm accountId={accountId} accountName={accountName} />
      </Dialog>
    </>
  );
}

function EditSettings({
  accountId,
  name,
  institution,
  includedInReports
}: {
  accountId: string;
  name: string;
  institution: string | null;
  includedInReports: boolean;
}) {
  const [state, action] = useActionState(updateAccountAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Name" htmlFor="edit-name">
        <Input id="edit-name" name="name" required maxLength={120} defaultValue={name} />
      </Field>
      <Field label="Institution" htmlFor="edit-institution">
        <Input
          id="edit-institution"
          name="institution"
          maxLength={120}
          defaultValue={institution ?? ""}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="hidden" name="includedInReports" value="off" />
        <input
          type="checkbox"
          name="includedInReports"
          value="on"
          defaultChecked={includedInReports}
          className="h-4 w-4"
        />
        Include in reports
      </label>
      <SubmitButton>Save changes</SubmitButton>
    </form>
  );
}

function SharePanel({ accountId, members }: { accountId: string; members: Member[] }) {
  const [state, action] = useActionState(shareAccountAction, undefined);
  const others = members.filter((m) => m.email);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Invite family members first (Settings → Members), then share this account with them here.
        </p>
      ) : (
        <>
          <Field label="Family member" htmlFor="share-user">
            <Select id="share-user" name="userId" required>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.email})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Permission" htmlFor="permission">
            <Select id="permission" name="permission" defaultValue="read_only">
              <option value="read_only">View only</option>
              <option value="read_write">Can edit details (not amounts)</option>
              <option value="full_control">Full control</option>
            </Select>
          </Field>
          <div className="flex gap-2">
            <SubmitButton name="op" value="share">
              Grant / update
            </SubmitButton>
            <SubmitButton name="op" value="unshare" variant="secondary">
              Remove access
            </SubmitButton>
          </div>
        </>
      )}
    </form>
  );
}

function DeleteForm({ accountId, accountName }: { accountId: string; accountName: string }) {
  const close = useDialogClose();
  const [state, action] = useActionState(deleteAccountAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <p className="text-sm text-muted-foreground">
        Type <strong>{accountName}</strong> to confirm.
      </p>
      <Input name="confirmName" aria-label="Confirmation text" required autoComplete="off" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} className="rounded-lg px-3 py-2 text-sm">
          Cancel
        </button>
        <SubmitButton variant="destructive" type="submit">
          Delete forever
        </SubmitButton>
      </div>
    </form>
  );
}

function BalanceTrackingPanel({
  accountId,
  currency,
  current,
  preview
}: {
  accountId: string;
  currency: string;
  current: "valuation" | "transactions";
  preview: TrackingPreview;
}) {
  const [state, action] = useActionState(switchBalanceTrackingAction, undefined);
  const toTransactions = preview.to === "transactions";
  const laterValuations = Math.max(0, preview.valuationCount - 1);
  const blocked = toTransactions && (preview.meroshareLinked || preview.holdingsManaged);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="to" value={preview.to} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      {state?.ok ? <p className="text-sm text-success">Balance tracking switched.</p> : null}

      <dl className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Current balance</dt>
          <dd className="tabular font-medium">{fmtMoney(preview.currentBalanceMinor, currency)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            Balance after switching to {toTransactions ? "transactions" : "valuations"}
          </dt>
          <dd className="tabular font-medium">
            {fmtMoney(preview.resultingBalanceMinor, currency)}
          </dd>
        </div>
      </dl>

      {toTransactions ? (
        preview.valuationCount > 0 ? (
          <p className="text-sm text-muted-foreground">
            Your earliest valuation
            {preview.earliestValuationDate
              ? ` (${fmtDate(preview.earliestValuationDate)})`
              : ""}{" "}
            becomes the opening transaction.
            {preview.openingTransactionAmountMinor !== null
              ? ` A valuation states the whole balance on its date, so the opening transaction is recorded as ${fmtMoney(-preview.openingTransactionAmountMinor, currency)} — the amount that reconciles your opening balance and any transactions up to that date with that balance. It counts toward the balance only; reports do not treat it as income or spending.`
              : ""}
            {laterValuations > 0
              ? ` ${laterValuations} later valuation${laterValuations === 1 ? "" : "s"} will be removed — they are balance snapshots and have no meaning as transactions.`
              : ""}
            {preview.restatedOpeningAdjustments > 0
              ? ` ${preview.restatedOpeningAdjustments} earlier opening adjustment${preview.restatedOpeningAdjustments === 1 ? "" : "s"} dated after that valuation will be restated to zero — this valuation now carries the balance ${preview.restatedOpeningAdjustments === 1 ? "it" : "they"} represented, so it is not counted twice.`
              : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            This account has no valuations to convert. Its balance will be rebuilt from the opening
            balance and its existing transactions.
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          Existing transactions will stop counting toward the balance. The balance will follow
          valuations again — the latest recorded valuation, or the opening balance if there is none
          — until you record a new valuation.
        </p>
      )}

      {blocked ? (
        <p className="text-sm text-destructive">
          {preview.meroshareLinked
            ? "This account is linked to MeroShare, which controls its balance through valuations. Disconnect MeroShare before switching it to transaction tracking."
            : "This account's value is managed by its portfolio holdings. Remove all holdings before switching it to transaction tracking."}
        </p>
      ) : (
        <SubmitButton>
          {current === "valuation"
            ? "Switch to transaction tracking"
            : "Switch to valuation tracking"}
        </SubmitButton>
      )}
    </form>
  );
}
