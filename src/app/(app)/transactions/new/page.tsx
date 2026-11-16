import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import { listCategories } from "@/server/domain/categories";
import { listTags } from "@/server/domain/tags";
import { PageHeader } from "@/components/ds/card";
import { TransactionComposer } from "@/components/finance/transaction-composer";
import { parseComposerParams } from "@/lib/transaction-composer";
import { todayIn } from "@/lib/datetime";

export const metadata = { title: "New transaction" };

export default async function NewTransactionPage({
  searchParams
}: {
  searchParams: Promise<{ account?: string; kind?: string }>;
}) {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const [accounts, categories, tags] = await Promise.all([
    listAccountsForActor(db, actor),
    listCategories(db, actor.familyId),
    listTags(db, actor.familyId)
  ]);
  const eligible = accounts
    .filter((a) => a.status === "active" && a.level === "full_control")
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency }));

  // Direct-entry parameters are parsed and validated here, on the server:
  // the composer receives plain props and never reads the URL itself.
  // Unknown accounts/kinds fall back safely instead of crashing.
  const params = await searchParams;
  const { initialAccountId, initialMode } = parseComposerParams(
    params,
    new Set(eligible.map((a) => a.id))
  );

  return (
    <div className="max-w-4xl space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title="New transaction"
        subtitle={`Amounts are recorded in ${family.currency} family context per account currency.`}
      />
      <TransactionComposer
        accounts={eligible}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        tags={tags.map((t) => ({ id: t.id, name: t.name }))}
        today={todayIn(family.timezone)}
        initialAccountId={initialAccountId}
        initialMode={initialMode}
        idPrefix="new-txn"
      />
    </div>
  );
}
