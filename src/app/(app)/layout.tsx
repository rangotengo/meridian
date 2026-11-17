import { eq } from "drizzle-orm";
import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { listAccountsForActor, isLiability } from "@/server/domain/accounts";
import { listCategories } from "@/server/domain/categories";
import { listRecentMerchants } from "@/server/domain/merchants";
import { netWorthMinorForAccounts } from "@/server/domain/reports";
import { getPreference } from "@/server/domain/users";
import { signOutAction, togglePrivacyAction } from "@/server/actions/session-actions";
import { Shell } from "@/components/layout/shell";
import { todayIn } from "@/lib/datetime";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  const privacy = user
    ? await getPreference<boolean>(
        (user?.preferences ?? {}) as Record<string, unknown>,
        "privacy_mode",
        false
      )
    : false;

  const accounts = await listAccountsForActor(db, actor);
  const [categoryNodes, merchants] = await Promise.all([
    listCategories(db, actor.familyId),
    listRecentMerchants(db, actor)
  ]);
  const categories = categoryNodes.map((c) => ({
    id: c.id,
    name: c.name,
    parentName: c.parentId ? (categoryNodes.find((p) => p.id === c.parentId)?.name ?? null) : null
  }));
  const active = accounts.filter((a) => a.status === "active");
  const reportAccounts = active.filter((a) => a.includedInReports);
  const toNav = (a: (typeof accounts)[number]) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    displayBalanceMinor: a.displayBalanceMinor,
    currency: a.currency
  });
  const assets = active.filter((a) => !isLiability(a.type)).map(toNav);
  const liabilities = active.filter((a) => isLiability(a.type)).map(toNav);
  const today = todayIn(family.timezone);
  const { netWorthMinor, fx: sidebarFx } = await netWorthMinorForAccounts(
    db,
    family,
    reportAccounts.map((a) => ({
      displayBalanceMinor: a.displayBalanceMinor,
      currency: a.currency
    })),
    today
  );
  return (
    <Shell
      user={actor.name}
      email={actor.email}
      family={family.name}
      privacy={privacy}
      assets={assets}
      liabilities={liabilities}
      categories={categories}
      merchants={merchants}
      netWorthMinor={netWorthMinor}
      fxIssues={sidebarFx.fxIssues}
      currency={family.currency}
      signOut={signOutAction}
      togglePrivacy={togglePrivacyAction}
      showAdmin={actor.platformRole === "super_admin"}
    >
      {children}
    </Shell>
  );
}
