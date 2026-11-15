import Link from "next/link";
import { getDb } from "@/server/db/client";
import { loadActor } from "@/server/auth/context";
import { getInvitationByToken } from "@/server/domain/invitations";
import { getInstanceInvitationByToken } from "@/server/domain/instance-invitations";
import { Card } from "@/components/ds/card";
import { AcceptExistingForm, AcceptNewAccountForm, CreateHouseholdForm } from "./accept-forms";
import { usesCloudflareAccess } from "@/server/auth/access";

export const metadata = { title: "Accept invitation" };

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const actor = await loadActor();
  const invitation = await getInvitationByToken(db, token);

  if (!invitation) {
    // Not a family invitation — it may be an instance invitation, which
    // creates a brand-new household rather than joining an existing family.
    const instanceInvitation = usesCloudflareAccess()
      ? null
      : await getInstanceInvitationByToken(db, token);
    if (instanceInvitation) {
      return (
        <Card>
          <h1 className="text-lg font-semibold">Create your household</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {instanceInvitation.invitedByName} invited <strong>{instanceInvitation.email}</strong>{" "}
            to start a new household on this Meridian instance.
          </p>
          <div className="mt-5">
            {actor ? (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                You are signed in as {actor.email}. Sign out first, then open this link again to
                create the new household.
              </p>
            ) : (
              <CreateHouseholdForm token={token} email={instanceInvitation.email} />
            )}
          </div>
        </Card>
      );
    }
  }

  if (!invitation) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Invitation unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This invitation link is invalid, already used, or expired. Ask the family admin for a new
          one.
        </p>
        <Link
          href="/sign-in"
          className="mt-4 inline-block text-primary underline-offset-4 hover:underline"
        >
          Go to sign in
        </Link>
      </Card>
    );
  }

  const signedInMatching = actor && actor.email.toLowerCase() === invitation.email;

  return (
    <Card>
      <h1 className="text-lg font-semibold">Join “{invitation.familyName}”</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {invitation.invitedByName} invited <strong>{invitation.email}</strong> as{" "}
        {invitation.role === "admin" ? "an admin" : "a member"}.
      </p>
      <div className="mt-5">
        {signedInMatching ? (
          <AcceptExistingForm token={token} />
        ) : actor ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            You are signed in as {actor.email}, but this invitation was sent to {invitation.email}.
            Sign out and use that account, or open the link while signed out.
          </p>
        ) : usesCloudflareAccess() ? (
          <>
            <p className="mb-3 text-sm">Accept with your verified Cloudflare Access identity.</p>
            <AcceptExistingForm token={token} />
          </>
        ) : (
          <>
            <h2 className="mb-3 text-sm font-medium">Create your account to accept</h2>
            <AcceptNewAccountForm token={token} email={invitation.email} />
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Already have an account with this email?{" "}
              <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
                Sign in first
              </Link>
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
