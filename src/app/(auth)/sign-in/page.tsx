import { redirect } from "next/navigation";
import { loadActor, loadAccessIdentity } from "@/server/auth/context";
import { usesCloudflareAccess } from "@/server/auth/access";
import { validateNextPath } from "@/lib/next-path";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = validateNextPath((await searchParams).next);
  const actor = await loadActor();
  if (actor) redirect(next);
  if (usesCloudflareAccess()) {
    const identity = await loadAccessIdentity();
    return (
      <AuthShell
        title="Welcome to Meridian"
        subtitle="Sign in with an email code or Google through Cloudflare Access."
      >
        {identity ? (
          <div className="space-y-4 text-sm">
            <p>Signed in as {identity.email}.</p>
            <a href="/sign-up" className="underline">
              Set up your household
            </a>
          </div>
        ) : (
          <p className="text-sm">
            Your sign-in could not be verified. Ask the operator to check your access.
          </p>
        )}
        <a href="/cdn-cgi/access/logout" className="mt-4 inline-block text-sm underline">
          Use a different account
        </a>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Meridian household">
      <SignInForm next={next} />
    </AuthShell>
  );
}
