import Link from "next/link";
import { redirect } from "next/navigation";
import { loadActor, loadAccessIdentity } from "@/server/auth/context";
import { usesCloudflareAccess } from "@/server/auth/access";
import { registrationOpen } from "@/lib/env";
import { AccessHouseholdForm } from "./access-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "./sign-up-form";

export const metadata = { title: "Create your account" };

export default async function SignUpPage() {
  const actor = await loadActor();
  if (actor) redirect("/");
  if (usesCloudflareAccess()) {
    const identity = await loadAccessIdentity();
    if (!identity) redirect("/sign-in");
    return (
      <AuthShell
        title="Set up your household"
        subtitle="Your email is verified. Choose how to organize your ledger."
      >
        <AccessHouseholdForm email={identity.email} />
      </AuthShell>
    );
  }
  if (!registrationOpen()) {
    return (
      <AuthShell
        title="Registration is invite-only"
        subtitle="This instance does not accept public sign-ups"
      >
        <p className="text-center text-sm text-muted-foreground">
          Ask the instance administrator for an invitation link. If someone already invited you,
          open the link from that email to create your household.
        </p>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/sign-in"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Create your account" subtitle="Start a household ledger in a few minutes">
      <SignUpForm />
    </AuthShell>
  );
}
