import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { sureImportStatus } from "@/server/domain/sure-import";
import { Card, PageHeader, Alert } from "@/components/ds/card";
import { SetupPanel } from "@/components/ds/setup-panel";
import { pluralize } from "@/lib/format";
import { DeleteFamilyForm } from "./delete-family-form";
import { FamilyImportForm } from "./family-import-form";
import { SureImportForm } from "./sure-import-form";

export const metadata = { title: "Your data" };

export default async function DataPage() {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const sure = await sureImportStatus(getDb(), actor.familyId);

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

      <SetupPanel
        title="Move from Sure"
        description="Import Sure's standard family export into a new Meridian family. Accounts, categories, tags, transactions, splits, transfers, and valuations are carried across with their original dates."
        complete={sure.imported}
        summary={
          sure.imported
            ? `Imported from Sure · ${pluralize(sure.accounts, "account")} · ${pluralize(sure.transactions, "transaction")}`
            : ""
        }
        panelId="sure-setup-panel"
      >
        <SureImportForm />
      </SetupPanel>

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
