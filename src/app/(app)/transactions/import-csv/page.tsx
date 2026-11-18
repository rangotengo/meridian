import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import { PageHeader } from "@/components/ds/card";
import { ImportCsvView } from "./import-csv-view";

export const metadata = { title: "Import statement CSV" };

export default async function ImportCsvPage() {
  const actor = await requireVerifiedActor();
  const accounts = (await listAccountsForActor(getDb(), actor))
    .filter((a) => a.status === "active")
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency }));

  return (
    <div className="space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title="Import statement CSV"
        subtitle="Upload a bank statement, map its columns, preview what will be recorded, then import. Duplicates are never recorded twice."
      />
      <ImportCsvView accounts={accounts} />
    </div>
  );
}
