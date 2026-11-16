/**
 * OAuth consent page. Meridian's own session login is the login of
 * record: this page requires an authenticated, email-verified session
 * (invite-only registration and verification are never bypassed), and
 * everything it displays — client name, scopes, household — comes from
 * the resolved client record and the signed-in user's current state,
 * never from raw request parameters.
 */
import { notFound, redirect } from "next/navigation";
import { asc, inArray } from "drizzle-orm";
import { ShieldCheckIcon } from "lucide-react";
import { mcpConfig, requireEmailVerification } from "@/lib/env";
import { currentFamily, loadActor } from "@/server/auth/context";
import { accessibleAccountIds } from "@/server/authorization/access";
import { getDb } from "@/server/db/client";
import { accounts } from "@/server/db/schema";
import {
  OAuthError,
  createAuthorizationRequest,
  validateAuthorizeRequest
} from "@/server/domain/oauth";
import { SCOPE_DESCRIPTIONS } from "@/server/mcp/scopes";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { approveConnectionAction, denyConnectionAction } from "./actions";

export const metadata = { title: "Connect an AI assistant", robots: { index: false } };

type RawParams = Record<string, string | string[] | undefined>;

function single(params: RawParams, key: string): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

/**
 * The decision forms carry the server-side record id and its CSRF
 * token. Everything the approval acts on — client, redirect_uri, scopes,
 * resource, code challenge, household — is read back from the record,
 * so a decision cannot be transplanted onto a different request. The
 * exceptions are the consent CHOICES rather than request data: the
 * account picker's selection (validated at approval time against the
 * accounts the user can currently access, see
 * approveAuthorizationRequest, and can only narrow the grant) and the
 * SSIS opt-in checkbox (unchecked by default; it can only add the
 * separate SSIS permission the user is explicitly offered here).
 */
function hiddenFields(recordId: string, csrfToken: string) {
  return (
    <>
      <input type="hidden" name="request_id" value={recordId} />
      <input type="hidden" name="csrf_token" value={csrfToken} />
    </>
  );
}

export default async function AuthorizePage({
  searchParams
}: {
  searchParams: Promise<RawParams>;
}) {
  const config = mcpConfig();
  if (!config) notFound();
  const params = await searchParams;

  const actor = await loadActor();
  if (!actor) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") query.set(key, value);
    }
    redirect(`/sign-in?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`);
  }
  if (requireEmailVerification() && !actor.emailVerified) {
    redirect("/verify-email");
  }

  const exec = await getDb();
  let request;
  try {
    request = await validateAuthorizeRequest(
      exec,
      {
        clientId: single(params, "client_id"),
        redirectUri: single(params, "redirect_uri"),
        responseType: single(params, "response_type"),
        codeChallenge: single(params, "code_challenge"),
        codeChallengeMethod: single(params, "code_challenge_method"),
        scope: single(params, "scope"),
        resource: single(params, "resource"),
        state: single(params, "state")
      },
      config
    );
  } catch (error) {
    // Validation failures render here — the user is never redirected to
    // a redirect_uri that has not been validated.
    const message =
      error instanceof OAuthError
        ? error.message
        : "This connection request could not be verified.";
    return (
      <AuthShell title="Connection request problem" subtitle="Nothing was connected">
        <div className="space-y-4 text-sm">
          <p>{message}</p>
          <p className="text-muted-foreground">
            Close this tab and start the connection again from your AI assistant. If the problem
            repeats, the assistant&rsquo;s client configuration does not match this Meridian
            instance.
          </p>
        </div>
      </AuthShell>
    );
  }

  const family = await currentFamily(actor);
  // Persist the validated request server-side; consent acts on the
  // record, never on resubmitted parameters.
  const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });

  // Accounts the picker may offer: exactly the accounts this user can
  // access in the bound household right now. The approval re-validates
  // the submitted selection against the same rule, so a tampered form
  // cannot widen the grant beyond this list.
  const accessibleIds = await accessibleAccountIds(exec, actor);
  const consentAccounts =
    accessibleIds.length > 0
      ? await exec
          .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
          .from(accounts)
          .where(inArray(accounts.id, accessibleIds))
          .orderBy(asc(accounts.name))
      : [];

  return (
    <AuthShell
      title="Connect an AI assistant"
      subtitle={`${request.client.clientName} wants read-only access to your Meridian data`}
    >
      <div className="space-y-5 text-sm">
        <div className="rounded-lg border p-4">
          <p className="font-medium">Household</p>
          <p className="mt-1 text-muted-foreground">
            This connection is bound to{" "}
            <span className="font-medium text-foreground">{family.name}</span> only. If you later
            move to a different household, the connection stops working instead of following you.
          </p>
        </div>

        <div>
          <p className="font-medium">It will be able to</p>
          <ul className="mt-2 space-y-2">
            {request.scopes.map((scope) => (
              <li key={scope} className="flex gap-2">
                <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">{SCOPE_DESCRIPTIONS[scope] ?? scope}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="font-medium">SSIS investment insight (optional)</p>
          <p className="mt-1 text-muted-foreground">
            Meridian also keeps an SSIS insight for this household — the Siddhartha Systematic
            Investment Scheme tracker, with its purchase history, statement entries and NAV history.
            It is household-wide data held separately from your accounts, so the account choices
            above do not restrict it.
          </p>
          <label className="mt-2 flex items-start gap-2 text-muted-foreground">
            <input
              type="checkbox"
              name="ssis_access"
              value="1"
              form="oauth-approve-form"
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              Allow {request.client.clientName} to read the SSIS insight for this household. Leave
              this unchecked to keep SSIS private — you can change it later under Settings →
              Connected AI agents.
            </span>
          </label>
        </div>

        {consentAccounts.length > 1 ? (
          <div>
            <p className="font-medium">Accounts</p>
            <p className="mt-1 text-muted-foreground">
              The connection can see every account you can access. Uncheck accounts to restrict it
              to only those — at least one account must stay selected.
            </p>
            {/* The checkboxes live outside the approve form in the layout
                but belong to it via the form attribute; the hidden marker
                tells the action a selection was offered, so "no account_id
                fields" unambiguously means "everything unchecked". */}
            <input type="hidden" name="account_selection" value="1" form="oauth-approve-form" />
            <ul className="mt-2 space-y-2">
              {consentAccounts.map((account) => (
                <li key={account.id}>
                  <label className="flex items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      name="account_id"
                      value={account.id}
                      defaultChecked
                      form="oauth-approve-form"
                      className="h-4 w-4 shrink-0"
                    />
                    <span>
                      {account.name} <span className="text-xs">({account.currency})</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="rounded-lg bg-muted p-4 text-muted-foreground">
          <p>
            Meridian shares your financial data with {request.client.clientName} when you approve.
            The assistant&rsquo;s provider processes that data under its own privacy policy. Access
            is read-only, lasts up to 90 days, and you can disconnect it at any time — revocation
            takes effect immediately.
          </p>
        </div>

        <div className="flex gap-3">
          <form action={approveConnectionAction} id="oauth-approve-form" className="flex-1">
            {hiddenFields(record.id, csrfToken)}
            <Button type="submit" className="w-full">
              Approve connection
            </Button>
          </form>
          <form action={denyConnectionAction} className="flex-1">
            {hiddenFields(record.id, csrfToken)}
            <Button type="submit" variant="outline" className="w-full">
              Deny
            </Button>
          </form>
        </div>
      </div>
    </AuthShell>
  );
}
