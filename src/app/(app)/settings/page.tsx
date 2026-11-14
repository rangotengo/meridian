import { eq } from "drizzle-orm";
import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { cookies } from "next/headers";
import { getPreference, getUserPrivacyMode } from "@/server/domain/users";
import { Card, PageHeader } from "@/components/ds/card";
import { ProfileForms } from "./forms";
import { OrgForm } from "./org-form";
import Link from "next/link";

export const metadata = { title: "Settings" };

const TIMEZONES = [
  "Etc/UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Singapore",
  "Australia/Sydney"
];

export default async function SettingsPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  const privacy = user ? await getUserPrivacyMode(db, actor.userId) : false;
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>;
  const themePref = await getPreference<string>(prefs, "theme", "system");
  const themeCookie = (await cookies()).get("theme")?.value;
  const theme =
    themeCookie === "light" || themeCookie === "dark" || themeCookie === "system"
      ? themeCookie
      : themePref === "light" || themePref === "dark" || themePref === "system"
        ? themePref
        : "system";

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-base font-medium">Profile & preferences</h2>
          <ProfileForms
            name={actor.name}
            email={actor.email}
            timezone={family.timezone}
            timezones={TIMEZONES}
            privacy={privacy}
            theme={theme}
            canEditTimezone={actor.familyRole === "admin"}
            accessManaged={actor.authProvider === "cloudflare-access"}
          />
        </Card>

        <Card>
          <h2 className="mb-4 text-base font-medium">Organization</h2>
          {actor.familyRole === "admin" ? (
            <OrgForm familyName={family.name} currency={family.currency} locale={family.locale} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only family admins can change organization settings. Ask an admin to update the family
              name, currency or locale.
            </p>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="mb-4 text-base font-medium">Manage</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                href: "/settings/recurring",
                label: "Recurring transactions",
                hint: "Automated bills & income"
              },
              { href: "/settings/categories", label: "Categories", hint: "Spending categories" },
              { href: "/settings/tags", label: "Tags", hint: "Flexible labels" },
              { href: "/settings/members", label: "Members", hint: "Family & invitations" },
              {
                href: "/settings/exchange-rates",
                label: "Exchange rates",
                hint: "Currency conversion rates"
              },
              { href: "/settings/security", label: "Security", hint: "Sessions & password" },
              { href: "/settings/data", label: "Data", hint: "Export & imports" }
            ].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded-lg px-3 py-2.5 ring-1 ring-foreground/10 transition-colors hover:bg-accent"
                >
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">{item.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
