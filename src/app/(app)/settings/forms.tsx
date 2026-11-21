"use client";

import { useActionState } from "react";
import {
  updateProfileAction,
  updateFamilySettingsAction,
  changeEmailAction,
  changePasswordAction,
  setMonthlyDigestAction,
  setPreferenceAction
} from "@/app/(app)/settings/actions";
import { Field, FormError, Input, Select } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { applyTheme, type ThemePreference } from "@/lib/theme";

export function ProfileForms({
  name,
  email,
  timezone,
  timezones,
  privacy,
  theme,
  monthlyDigest,
  canEditTimezone,
  accessManaged = false
}: {
  name: string;
  email: string;
  timezone: string;
  timezones: string[];
  privacy: boolean;
  theme: "light" | "dark" | "system";
  monthlyDigest: boolean;
  canEditTimezone: boolean;
  accessManaged?: boolean;
}) {
  return (
    <div className="space-y-6">
      <NameForm name={name} />
      <PrivacyToggle privacy={privacy} />
      <MonthlyDigestForm optedIn={monthlyDigest} email={email} />
      <AppearanceForm theme={theme} />
      {canEditTimezone ? (
        <TimezoneForm timezone={timezone} timezones={timezones} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Time zone is {timezone}. Only a family admin can change it.
        </p>
      )}
      {accessManaged ? (
        <p className="text-sm text-muted-foreground">
          Signed in as {email}. Your sign-in is managed by Cloudflare Access.
        </p>
      ) : (
        <>
          <ChangePasswordForm />
          <ChangeEmailForm currentEmail={email} />
        </>
      )}
    </div>
  );
}

function NameForm({ name }: { name: string }) {
  const [state, action] = useActionState(updateProfileAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <Field label="Display name" htmlFor="s-name">
        <Input id="s-name" name="name" defaultValue={name} required maxLength={120} />
      </Field>
      <SubmitButton variant="secondary">Save profile</SubmitButton>
      {state?.ok ? <p className="text-xs text-success">Saved.</p> : null}
    </form>
  );
}

function PrivacyToggle({ privacy }: { privacy: boolean }) {
  return (
    <form
      action={setPreferenceAction}
      className="flex items-center justify-between gap-4 rounded-lg border border-border p-3"
    >
      <input type="hidden" name="key" value="privacy_mode" />
      <input type="hidden" name="value" value={privacy ? "off" : "on"} />
      <div>
        <p className="text-sm font-medium">Privacy mode</p>
        <p className="text-xs text-muted-foreground">
          Hide every monetary amount on screen. Currently {privacy ? "on" : "off"}.
        </p>
      </div>
      <SubmitButton variant="secondary" className="shrink-0 whitespace-nowrap">
        {privacy ? "Turn off" : "Turn on"}
      </SubmitButton>
    </form>
  );
}

function MonthlyDigestForm({ optedIn, email }: { optedIn: boolean; email: string }) {
  const [state, action] = useActionState(setMonthlyDigestAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <FormError message={state?.ok === false ? state.error : undefined} />
      <div className="flex items-start gap-3">
        <input type="hidden" name="value" value="off" />
        <input
          id="s-digest"
          name="value"
          type="checkbox"
          value="on"
          defaultChecked={optedIn}
          className="mt-1 h-4 w-4"
        />
        <div>
          <label htmlFor="s-digest" className="text-sm font-medium">
            Email me a monthly summary
          </label>
          <p className="text-xs text-muted-foreground">
            Totals only — no transaction details. Sent only if an operator enables the monthly
            digest feature, to the verified address on this account ({email}).
          </p>
        </div>
      </div>
      <SubmitButton variant="secondary">Save email preference</SubmitButton>
      {state?.ok ? <p className="text-xs text-success">Saved.</p> : null}
    </form>
  );
}

function AppearanceForm({ theme }: { theme: "light" | "dark" | "system" }) {
  return (
    <form action={setPreferenceAction} className="space-y-3">
      <input type="hidden" name="key" value="theme" />
      <Field label="Appearance" htmlFor="s-theme">
        <Select
          id="s-theme"
          name="value"
          defaultValue={theme}
          onChange={(e) => applyTheme(e.target.value as ThemePreference)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </Select>
      </Field>
      <SubmitButton variant="secondary">Save appearance</SubmitButton>
    </form>
  );
}

function TimezoneForm({ timezone, timezones }: { timezone: string; timezones: string[] }) {
  const [state, action] = useActionState(updateFamilySettingsAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Time zone" htmlFor="s-tz">
        <Select id="s-tz" name="timezone" defaultValue={timezone}>
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton variant="secondary">Save time zone</SubmitButton>
      {state?.ok ? <p className="text-xs text-success">Saved.</p> : null}
    </form>
  );
}

function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, undefined);
  return (
    <form action={action} className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Change password</h3>
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Current password" htmlFor="cur-pw">
        <Input
          id="cur-pw"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label="New password" htmlFor="new-pw" hint="Other sessions will be signed out.">
        <Input
          id="new-pw"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
      </Field>
      <SubmitButton variant="secondary">Update password</SubmitButton>
    </form>
  );
}

function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [state, action] = useActionState(changeEmailAction, undefined);
  return (
    <form action={action} className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Change email</h3>
      <p className="text-xs text-muted-foreground">
        Current: {currentEmail}. You will need to verify the new address.
      </p>
      <FormError message={state?.ok === false ? state.error : undefined} />
      <Field label="Confirm with current password" htmlFor="email-pw">
        <Input
          id="email-pw"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label="New email" htmlFor="new-email">
        <Input id="new-email" name="newEmail" type="email" required />
      </Field>
      <SubmitButton variant="secondary">Request email change</SubmitButton>
    </form>
  );
}
