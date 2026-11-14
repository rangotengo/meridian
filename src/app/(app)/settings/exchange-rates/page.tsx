import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import { getRateInfo, isStaleRate, listLatestRates } from "@/server/domain/exchange-rates";
import { todayIn } from "@/lib/datetime";
import { Alert, Card, PageHeader } from "@/components/ds/card";
import { ExchangeRateForm } from "./manager";

export const metadata = { title: "Exchange rates" };

export default async function ExchangeRatesPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const today = todayIn(family.timezone);

  // Needed pairs come only from accounts THIS actor can see, so the
  // missing-rate list respects account permissions exactly like the
  // dashboard totals do.
  const accounts = await listAccountsForActor(db, actor);
  const neededCurrencies = [
    ...new Set(
      accounts
        .filter((a) => a.status === "active" && a.currency !== family.currency)
        .map((a) => a.currency)
    )
  ].sort();

  const needed = await Promise.all(
    neededCurrencies.map(async (currency) => {
      const info = await getRateInfo(db, currency, family.currency, today);
      return { currency, info };
    })
  );
  const missing = needed.filter((n) => n.info === null);

  const stored = await listLatestRates(db);

  return (
    <>
      <PageHeader
        title="Exchange rates"
        subtitle={`Reports convert foreign-currency accounts into ${family.currency}. Amounts with no rate are excluded from totals until a rate is added.`}
      />

      {missing.length > 0 ? (
        <Alert title="Missing rates — these currencies are excluded from your totals">
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {missing.map((n) => (
              <li key={n.currency}>
                <strong>
                  {n.currency} → {family.currency}
                </strong>
                : no rate on or before {today}.
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <h2 className="mb-4 text-base font-medium">Add or refresh a rate</h2>
        <ExchangeRateForm
          defaultBase={missing[0]?.currency ?? neededCurrencies[0] ?? "USD"}
          defaultQuote={family.currency}
          today={today}
        />
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-medium">Rates for your accounts</h2>
        {needed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All of your visible accounts are already in {family.currency}, so no conversion is
            needed.
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {needed.map((n) => (
              <li key={n.currency} className="flex items-center justify-between gap-3 py-2.5">
                <span className="font-medium">
                  {n.currency} → {family.currency}
                </span>
                {n.info ? (
                  <span className="tabular text-muted-foreground">
                    {n.info.rate} · as of {n.info.quotedOn}
                    {isStaleRate(n.info.quotedOn, today) ? (
                      <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                        Stale
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                    Missing
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-medium">All stored rates</h2>
        {stored.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exchange rates stored yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {stored.map((r) => (
              <li
                key={`${r.base}:${r.quote}`}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <span className="font-medium">
                  {r.base} → {r.quote}
                </span>
                <span className="tabular text-muted-foreground">
                  {r.rate} · as of {r.quotedOn}
                  {isStaleRate(r.quotedOn, today) ? (
                    <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                      Stale
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
