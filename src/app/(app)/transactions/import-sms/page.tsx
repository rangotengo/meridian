import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import { listCategories } from "@/server/domain/categories";
import { PageHeader } from "@/components/ds/card";
import { ImportSmsView } from "./import-sms-view";

export const metadata = { title: "Import SMS" };

export default async function ImportSmsPage() {
  const actor = await requireVerifiedActor();
  const db = getDb();
  const [accounts, categories] = await Promise.all([
    listAccountsForActor(db, actor),
    listCategories(db, actor.familyId)
  ]);

  return (
    <div className="space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title="Import from SMS"
        subtitle="Paste a bank or wallet SMS — Meridian parses it, matches the account by its digits, suggests a category from your history, and records it with one tap. The same SMS can never be recorded twice."
      />
      <ImportSmsView
        accounts={accounts
          .filter((a) => a.status === "active")
          .map((a) => ({
            id: a.id,
            name: a.name,
            currency: a.currency,
            institution: a.institution
          }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      />
    </div>
  );
}
