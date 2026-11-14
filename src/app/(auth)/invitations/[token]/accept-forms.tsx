"use client";

import { useActionState } from "react";
import {
  acceptInvitationAction,
  acceptInstanceInvitationAction
} from "@/app/(auth)/invitations/[token]/actions";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";

const HOUSEHOLD_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "NPR", "SGD", "JPY"];
const HOUSEHOLD_TIMEZONES = [
  "Etc/UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Singapore",
  "Australia/Sydney"
];

export function AcceptExistingForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInvitationAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <SubmitButton className="w-full">Join this family</SubmitButton>
    </form>
  );
}

export function AcceptNewAccountForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState(acceptInvitationAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" required maxLength={120} autoComplete="name" />
      </Field>
      <Field label="Email" htmlFor="emailDisplay">
        <Input id="emailDisplay" type="email" defaultValue={email} disabled />
      </Field>
      <Field
        label="Password"
        htmlFor="password"
        hint="At least 10 characters with a letter and a digit."
      >
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
      </Field>
      <SubmitButton className="w-full">Create account and join</SubmitButton>
    </form>
  );
}

export function CreateHouseholdForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState(acceptInstanceInvitationAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" required maxLength={120} autoComplete="name" />
      </Field>
      <Field label="Email" htmlFor="emailDisplay">
        <Input id="emailDisplay" type="email" defaultValue={email} disabled />
      </Field>
      <Field
        label="Family name"
        htmlFor="familyName"
        hint="You can invite partners or family members later."
      >
        <Input
          id="familyName"
          name="familyName"
          required
          maxLength={120}
          placeholder="e.g. The Shresthas"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reporting currency" htmlFor="currency">
          <Select id="currency" name="currency" defaultValue="USD">
            {HOUSEHOLD_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Time zone" htmlFor="timezone">
          <Select id="timezone" name="timezone" defaultValue="Etc/UTC">
            {HOUSEHOLD_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Password"
        htmlFor="password"
        hint="At least 10 characters with a letter and a digit."
      >
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
      </Field>
      <SubmitButton className="w-full">Create your household</SubmitButton>
    </form>
  );
}
