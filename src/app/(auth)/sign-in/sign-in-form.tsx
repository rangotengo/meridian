"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "lucide-react";
import { signInAction } from "../actions";
import { FormError } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@/components/ui/input-group";

export function SignInForm({ next = "/" }: { next?: string }) {
  const [state, action] = useActionState(signInAction, undefined);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={action} className="space-y-4">
      {next !== "/" ? <input type="hidden" name="next" value={next} /> : null}
      <FormError message={state?.ok === false ? state.error : undefined} />
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <MailIcon className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            required
          />
        </InputGroup>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <Link
            href="/forgot-password"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Forgot password?
          </Link>
        </div>
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <LockIcon className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="Enter your password"
            required
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              variant="ghost"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <EyeOffIcon className="size-3.5 text-muted-foreground" />
              ) : (
                <EyeIcon className="size-3.5 text-muted-foreground" />
              )}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <SubmitButton className="w-full">Sign in</SubmitButton>
      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/sign-up"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign up
        </Link>
      </p>
    </form>
  );
}
