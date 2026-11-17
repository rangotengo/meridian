import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import { getUserPrivacyMode } from "@/server/domain/users";
import { PageHeader } from "@/components/ds/card";
import { monthKeyIn } from "@/lib/datetime";
import { ledgerToDisplayBalance } from "@/lib/money";
import { DebtsView } from "./debts-view";

export const metadata = { title: "Debt payoff" };

export default async function DebtsPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const accounts = await listAccountsForActor(db, actor);
  // Loans are other_liability accounts. Credit cards are revolving debt
  // with minimum payments, not fixed loans, so they are not planned here.
  const loans = accounts
    .filter((a) => a.type === "other_liability" && a.status === "active")
    .map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      currency: a.currency,
      displayBalanceMinor: ledgerToDisplayBalance(a.displayBalanceMinor, a.type),
      interestRateBps: a.interestRateBps,
      canEdit: a.level === "full_control"
    }));
  const privacy = await getUserPrivacyMode(db, actor.userId);

  return (
    <div className="space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title="Debt payoff"
        subtitle="Extra-payment planner for loan accounts: payoff date, interest saved, and what an extra monthly payment is worth."
      />
      <DebtsView loans={loans} currentMonth={monthKeyIn(family.timezone)} privacy={privacy} />
    </div>
  );
}
