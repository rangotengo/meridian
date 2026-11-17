import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { todayIn } from "@/lib/datetime";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import { listCategories } from "@/server/domain/categories";
import { listEntriesPage } from "@/server/domain/entries";
import { listTags } from "@/server/domain/tags";
import { recentCategories, recentPayees } from "@/lib/recent-transactions";
import { Card, PageHeader } from "@/components/ds/card";
import { QuickAddForm } from "./form";

export const metadata = { title: "Quick add" };

export default async function QuickAddPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const [accounts, categories, tags, recent] = await Promise.all([
    listAccountsForActor(db, actor),
    listCategories(db, actor.familyId),
    listTags(db, actor.familyId),
    listEntriesPage(db, actor, { limit: 50 })
  ]);

  return (
    <div className="mx-auto w-full max-w-xl pb-6 lg:pb-12">
      <PageHeader title="Quick add" subtitle="Record a transaction in seconds." />
      <Card className="mt-6">
        <QuickAddForm
          accounts={accounts
            .filter((a) => a.status === "active" && a.level === "full_control")
            .map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          tags={tags.map((t) => ({ id: t.id, name: t.name }))}
          recentPayees={recentPayees(recent.items)}
          recentCategories={recentCategories(recent.items)}
          today={todayIn(family.timezone)}
        />
      </Card>
    </div>
  );
}
