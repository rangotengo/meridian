"use client";

import { useActionState, useState } from "react";
import { createInstanceInvitationAction } from "./actions";
import { Field, FormError, FormSuccess, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";

export function InstanceInviteForm({ manualDelivery = false }: { manualDelivery?: boolean }) {
  const [state, action] = useActionState(createInstanceInvitationAction, undefined);
  const [copied, setCopied] = useState(false);
  const inviteUrl = state?.ok && state.data ? state.data.inviteUrl : null;

  return (
    <>
      <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Email" htmlFor="instance-invite-email">
          <Input
            id="instance-invite-email"
            name="email"
            type="email"
            required
            placeholder="new.household@example.com"
          />
        </Field>
        <div className="flex items-end pb-0.5">
          <SubmitButton>{manualDelivery ? "Create invite link" : "Send invite"}</SubmitButton>
        </div>
      </form>
      {state?.ok === false ? <FormError message={state.error} /> : null}
      {state?.ok ? (
        <FormSuccess
          message={
            copied
              ? "Invite link copied to clipboard."
              : state.data?.emailQueued
                ? "Invitation created. Email delivery is queued."
                : "Invitation created. Copy this link and share it with the person you invited."
          }
        />
      ) : null}
      {inviteUrl ? (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(inviteUrl).then(() => setCopied(true));
          }}
          className="mt-2 max-w-full truncate rounded-lg border border-border px-3 py-2 text-left text-xs text-primary"
        >
          {inviteUrl}
        </button>
      ) : null}
    </>
  );
}
