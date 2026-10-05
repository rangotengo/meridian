import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listApiKeysForActor } from "@/server/domain/api-keys";
import { PageHeader } from "@/components/ds/card";
import { ApiKeysManager } from "./api-keys-manager";

export const metadata = { title: "API Keys & Shortcuts" };

export default async function ApiKeysPage() {
  const actor = await requireVerifiedActor();
  const db = getDb();
  const keys = await listApiKeysForActor(db, actor);

  return (
    <>
      <PageHeader
        title="API Keys & Shortcuts"
        subtitle="Manage access tokens for iOS Shortcuts, Android automation, and mobile bank SMS integrations."
      />
      <ApiKeysManager keys={keys} userName={actor.name} />
    </>
  );
}
