"use server";

/**
 * Consent decisions. Both actions consume the server-side
 * authorization-request record (bound to this user, this session, and a
 * CSRF token, and consumed exactly once) and act on the RECORD's fields —
 * never on submitted parameters. Redirects go only to the record's
 * already-validated redirect_uri; any failure stays on Meridian's own
 * pages. Every authorization response carries the RFC 9207 `iss`.
 */
import { notFound, redirect } from "next/navigation";
import { mcpConfig } from "@/lib/env";
import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { approveAuthorizationRequest, consumeAuthorizationRequest } from "@/server/domain/oauth";

function formValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function approveConnectionAction(formData: FormData): Promise<void> {
  const config = mcpConfig();
  if (!config) notFound();
  const actor = await requireVerifiedActor();
  const exec = await getDb();
  const requestId = formValue(formData, "request_id");
  if (!requestId) throw new Error("Missing connection request.");
  const record = await consumeAuthorizationRequest(exec, {
    requestId,
    actor,
    csrfToken: formValue(formData, "csrf_token")
  });
  // Account picker: the hidden marker is present only when the picker
  // was rendered, so its absence means "no restriction offered" (the
  // default all-accounts ceiling), while its presence with zero checked
  // accounts is an explicit empty selection the domain rejects. The ids
  // themselves are validated in approveAuthorizationRequest against the
  // actor's current account access — the form values are never trusted.
  const selection =
    formValue(formData, "account_selection") !== null
      ? {
          actor,
          accountIds: formData
            .getAll("account_id")
            .filter((value): value is string => typeof value === "string")
        }
      : undefined;
  const { code } = await approveAuthorizationRequest(exec, record, config, selection);
  const url = new URL(record.redirectUri);
  url.searchParams.set("code", code);
  if (record.state) url.searchParams.set("state", record.state);
  url.searchParams.set("iss", config.issuerUrl);
  redirect(url.toString());
}

export async function denyConnectionAction(formData: FormData): Promise<void> {
  const config = mcpConfig();
  if (!config) notFound();
  const actor = await requireVerifiedActor();
  const exec = await getDb();
  const requestId = formValue(formData, "request_id");
  if (!requestId) redirect("/");
  let record;
  try {
    record = await consumeAuthorizationRequest(exec, {
      requestId: requestId!,
      actor,
      csrfToken: formValue(formData, "csrf_token")
    });
  } catch {
    // An invalid or already-consumed record never produces a redirect to
    // a client URL — the flow simply ends on Meridian itself.
    redirect("/");
  }
  const url = new URL(record!.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "The user denied the connection request.");
  if (record!.state) url.searchParams.set("state", record!.state);
  url.searchParams.set("iss", config.issuerUrl);
  redirect(url.toString());
}
