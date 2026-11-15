import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { Card, PageHeader, Alert } from "@/components/ds/card";
import { DeleteFamilyForm } from "./delete-family-form";
import { FamilyImportForm } from "./family-import-form";
import { SureImportForm } from "./sure-import-form";

export const metadata = { title: "Your data" };

export default async function DataPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);

  return (
    <>
      <PageHeader
        title="Your data"
        subtitle="Portability and deletion. Your data belongs to you."
      />

      <Card>
        <h2 className="mb-1 text-base font-medium text-primary">Export everything</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Download a complete JSON snapshot of your family: accounts, entries, transfers,
          categories, tags, budgets, recurring series, saved filters, sharing, and exchange rates.
        </p>
        <a
          href="/api/export"
          className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg"
          download
        >
          Download export
        </a>
      </Card>

      <Card>
        <h2 className="mb-1 text-base font-medium text-primary">Restore a Meridian export</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Recreate a household from a Meridian export in this family. Family admins only, and the
          family must be empty so a restore can never merge or overwrite existing data.
        </p>
        <FamilyImportForm />
      </Card>

      <Card>
        <h2 className="mb-1 text-base font-medium text-primary">Move from Sure</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Import Sure&apos;s standard family export into a new Meridian family. Accounts,
          categories, tags, transactions, splits, transfers, and valuations are carried across with
          their original dates.
        </p>
        <SureImportForm />
      </Card>

      <Alert title="Deleting your family is permanent" tone="destructive">
        Every account, transaction, category, and member record will be destroyed immediately. There
        is no undo. Export first if you might want the data later.
      </Alert>

      {actor.familyRole === "admin" ? (
        <Card className="border-destructive/40">
          <h2 className="mb-3 text-base font-medium text-destructive">
            Delete family “{family.name}”
          </h2>
          <DeleteFamilyForm familyName={family.name} />
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-muted-foreground">
            Only a family admin can delete the whole family.
          </p>
        </Card>
      )}
    </>
  );
}
