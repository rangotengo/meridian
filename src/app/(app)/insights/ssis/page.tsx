import { PageHeader } from "@/components/ds/card";
import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { getSsisInsight } from "@/server/domain/ssis";
import { SsisManager } from "./manager";

export const metadata = { title: "SSIS Insight" };

export default async function SsisInsightPage() {
  const actor = await requireVerifiedActor();
  const data = await getSsisInsight(getDb(), actor);
  const subtitleParts: string[] = [];
  if (data.holderName) subtitleParts.push(`Holder: ${data.holderName}`);
  if (data.lastFetchedAt) {
    subtitleParts.push(
      `Last updated ${new Date(data.lastFetchedAt).toLocaleString()} via ${
        data.lastSource === "refresh" ? "live refresh" : "snapshot import"
      }`
    );
  }
  subtitleParts.push("Read-only insight — separate from your Meridian accounts and balances.");
  return (
    <>
      <PageHeader title={data.schemeName} subtitle={subtitleParts.join(" · ")} />
      <SsisManager data={data} />
    </>
  );
}
