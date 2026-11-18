import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { budgetOverview } from "@/server/domain/budgets";
import { isStaleRate } from "@/server/domain/exchange-rates";
import { getUserPrivacyMode } from "@/server/domain/users";
import { PageHeader } from "@/components/ds/card";
import { FxIssuesAlert } from "@/components/finance/fx-issues-alert";
import { BudgetsView } from "./budgets-view";
import { formatMonthKey, todayIn } from "@/lib/datetime";

export const metadata = { title: "Budgets" };

export default async function BudgetsPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const overview = await budgetOverview(getDb(), family, actor.userId);
  const privacy = await getUserPrivacyMode(getDb(), actor.userId);

  return (
    <div className="space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title="Budgets"
        subtitle={`Monthly limits per category, plus an overall cap. ${formatMonthKey(overview.monthKey, family.locale)}.`}
      />
      <FxIssuesAlert
        fx={{
          incomplete: overview.fx.incompleteFx,
          issues: overview.fx.fxIssues,
          rates: overview.fx.fxRates.map((r) => ({
            base: r.base,
            quote: r.quote,
            rate: r.rate,
            quotedOn: r.quotedOn,
            stale: isStaleRate(r.quotedOn, todayIn(family.timezone))
          }))
        }}
      />
      <BudgetsView
        currency={family.currency}
        overall={overview.overall}
        perCategory={overview.perCategory}
        summary={overview.summary}
        categoriesWithoutBudget={overview.categoriesWithoutBudget}
        monthLabel={formatMonthKey(overview.monthKey, family.locale)}
        privacy={privacy}
      />
    </div>
  );
}
