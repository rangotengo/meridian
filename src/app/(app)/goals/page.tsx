import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listGoalsWithProgress } from "@/server/domain/goals";
import { listAccountsForActor } from "@/server/domain/accounts";
import { listCategories } from "@/server/domain/categories";
import { getUserPrivacyMode } from "@/server/domain/users";
import { PageHeader } from "@/components/ds/card";
import { GoalsView } from "./goals-view";

export const metadata = { title: "Goals" };

export default async function GoalsPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const [goals, accounts, categories] = await Promise.all([
    listGoalsWithProgress(db, actor, family, { includeArchived: true }),
    listAccountsForActor(db, actor),
    listCategories(db, actor.familyId)
  ]);
  const privacy = await getUserPrivacyMode(db, actor.userId);

  return (
    <div className="space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title="Goals"
        subtitle="Savings targets linked to an account or a category. Progress is measured from live ledger data — account goals track balance growth since creation, category goals track income earned in that category since creation."
      />
      <GoalsView
        goals={goals}
        accounts={accounts
          .filter((a) => a.status === "active")
          .map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        currency={family.currency}
        privacy={privacy}
      />
    </div>
  );
}
