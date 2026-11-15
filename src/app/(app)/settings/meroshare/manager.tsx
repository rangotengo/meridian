"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import {
  connectMeroShareAction,
  disconnectMeroShareAction,
  meroShareCapitalsAction,
  syncMeroShareAction,
  type MeroShareSyncResult
} from "./actions";
import { Alert } from "@/components/ds/card";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { ConfirmDialog } from "@/components/ds/dialog";
import { usePrivacy } from "@/components/layout/privacy-context";

type Capital = { id: number; code: string; name: string };

/**
 * Shown after a connect/sync that succeeded without cost basis: the
 * portfolio is up to date, but purchase costs could not be retrieved and
 * previously stored values were kept.
 */
function CostBasisWarning({ result }: { result?: MeroShareSyncResult }) {
  if (!result || result.costBasisAvailable) return null;
  return (
    <Alert title="Cost basis unavailable" tone="warning">
      <p>
        {result.warnings[0] ??
          "MeroShare's WACC report could not be retrieved, so holdings were synced without purchase cost."}
      </p>
    </Alert>
  );
}
type Connection = {
  connection: {
    id: string;
    name: string;
    dpCode: string;
    dpName: string;
    lastSyncedAt: Date | null;
  };
  accounts: Array<{
    id: string;
    name: string;
    boid: string;
    totalValueMinor: number;
    lastSyncedAt: Date | null;
    holdings: Array<{ ticker: string; name: string; quantity: string; marketValueMinor: number }>;
  }>;
};

export function MeroShareManager({ connections }: { connections: Connection[] }) {
  const privacy = usePrivacy();
  const [capitals, setCapitals] = useState<Capital[]>([]);
  const [capitalError, setCapitalError] = useState<string>();
  useEffect(() => {
    void meroShareCapitalsAction().then((result) => {
      if (result.ok) setCapitals(result.data ?? []);
      else setCapitalError(result.error);
    });
  }, []);

  return (
    <div className="space-y-6">
      <ConnectForm capitals={capitals} capitalError={capitalError} />
      {connections.length ? (
        <section className="space-y-3" aria-label="Connected MeroShare portfolios">
          {connections.map((item) => (
            <ConnectionCard key={item.connection.id} item={item} privacy={privacy} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ConnectionCard({ item, privacy }: { item: Connection; privacy: boolean }) {
  const [syncState, syncAction] = useActionState(syncMeroShareAction, undefined);
  const [disconnectState, disconnectAction] = useActionState(disconnectMeroShareAction, undefined);

  const formatNprValue = (minor: number) => (privacy ? "•••••" : formatNpr(minor));

  return (
    <article className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      <FormError message={syncState?.ok === false ? syncState.error : undefined} />
      <FormError message={disconnectState?.ok === false ? disconnectState.error : undefined} />
      <CostBasisWarning result={syncState?.ok ? syncState.data : undefined} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-primary">{item.connection.name}</h2>
          <p className="text-sm text-muted-foreground">
            {item.connection.dpName} · last synced{" "}
            {item.connection.lastSyncedAt
              ? new Date(item.connection.lastSyncedAt).toLocaleString()
              : "never"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form action={syncAction}>
            <input type="hidden" name="connectionId" value={item.connection.id} />
            <SubmitButton variant="secondary">Sync now</SubmitButton>
          </form>
          <ConfirmDialog
            trigger={
              <span className="inline-flex rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover">
                Disconnect
              </span>
            }
            title={`Disconnect ${item.connection.name}?`}
            description="Meridian keeps the investment account and its latest valuation. Credentials are removed."
            confirmLabel="Disconnect"
            action={disconnectAction}
          >
            <input type="hidden" name="connectionId" value={item.connection.id} />
          </ConfirmDialog>
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
        {item.accounts.map((account) => (
          <li key={account.id} className="px-3 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <Link className="font-medium hover:underline" href={`/accounts/${account.id}`}>
                {account.name}
              </Link>
              <span className="text-muted-foreground">
                DEMAT •••• {account.boid.slice(-4)} · {formatNprValue(account.totalValueMinor)}
              </span>
            </div>
            {account.holdings.length ? (
              <div className="mt-3 overflow-x-auto rounded-md bg-surface-inset">
                <table className="w-full min-w-[420px] text-left text-xs">
                  <thead className="border-b border-border text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Scrip</th>
                      <th className="px-3 py-2 text-right font-medium">Quantity</th>
                      <th className="px-3 py-2 text-right font-medium">Current value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/80">
                    {account.holdings.map((holding) => (
                      <tr key={holding.ticker}>
                        <td className="px-3 py-2">
                          <span className="font-medium text-primary">{holding.ticker}</span>
                          <span className="ml-2 text-muted-foreground">{holding.name}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatQuantity(holding.quantity)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatNprValue(holding.marketValueMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">No current holdings reported.</p>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Disconnecting deletes stored MeroShare credentials and portfolio sync data, but retains the
        Meridian investment account and its latest valuation.
      </p>
    </article>
  );
}

function formatNpr(minor: number): string {
  return new Intl.NumberFormat("en-NP", { style: "currency", currency: "NPR" }).format(minor / 100);
}

function formatQuantity(value: string): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 8 }).format(Number(value));
}

function ConnectForm({ capitals, capitalError }: { capitals: Capital[]; capitalError?: string }) {
  const [state, action] = useActionState(connectMeroShareAction, undefined);
  const [selectedId, setSelectedId] = useState("");
  const selected = capitals.find((capital) => String(capital.id) === selectedId);
  return (
    <form
      action={action}
      className="space-y-4 rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div>
        <h2 className="font-medium text-primary">Connect MeroShare</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Meridian signs in directly with CDSC to read your portfolio. Your CDSC session token is
          never stored; your login is encrypted at rest with your server key.
        </p>
      </div>
      <FormError message={state?.ok === false ? state.error : capitalError} />
      <CostBasisWarning result={state?.ok ? state.data : undefined} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Depository participant" htmlFor="mero-dp">
          <Select
            id="mero-dp"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled={capitals.length === 0}
          >
            <option value="">Choose your DP/capital</option>
            {capitals.map((capital) => (
              <option key={capital.id} value={capital.id}>
                {capital.name} ({capital.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Client ID" htmlFor="mero-client-id">
          <Input id="mero-client-id" name="clientId" value={selected?.id ?? ""} readOnly />
        </Field>
        <Field label="DP code" htmlFor="mero-dp-code">
          <Input id="mero-dp-code" name="dpCode" value={selected?.code ?? ""} readOnly />
        </Field>
        <Field label="DP name" htmlFor="mero-dp-name">
          <Input id="mero-dp-name" name="dpName" value={selected?.name ?? ""} readOnly />
        </Field>
        <Field label="MeroShare username" htmlFor="mero-username">
          <Input id="mero-username" name="username" required autoComplete="off" />
        </Field>
        <Field label="MeroShare password" htmlFor="mero-password">
          <Input id="mero-password" name="password" type="password" required autoComplete="off" />
        </Field>
      </div>
      <SubmitButton disabled={!selected}>Save and sync initial portfolio</SubmitButton>
    </form>
  );
}
