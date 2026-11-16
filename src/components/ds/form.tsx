import type { ComponentProps } from "react";

/**
 * Shared form controls with two densities:
 *
 * - "compact" (default): 32px controls for settings and other dense forms.
 * - "comfortable": 44px controls with roomier padding for primary
 *   data-entry surfaces such as Quick Add.
 *
 * Height, padding, and line-height are always set together per density so
 * a fixed height can never clip the typed or selected value — the bug that
 * `h-8` combined with a caller's `py-3` override caused in Quick Add.
 * Callers must not re-add per-field padding overrides on top of a density.
 */
export type ControlDensity = "compact" | "comfortable";

const baseClass =
  "w-full rounded-lg border border-input bg-background shadow-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60";

const densityClass: Record<ControlDensity, string> = {
  compact: "h-8 px-2.5 py-1 text-sm leading-5",
  comfortable: "h-11 px-3 py-2 text-base leading-6"
};

const selectPaddingClass: Record<ControlDensity, string> = {
  compact: "pr-8",
  comfortable: "pr-10"
};

type InputProps = ComponentProps<"input"> & { density?: ControlDensity };
type TextareaProps = ComponentProps<"textarea"> & { density?: ControlDensity };
type SelectProps = ComponentProps<"select"> & { density?: ControlDensity };

export function Input({ density = "compact", className = "", ...props }: InputProps) {
  return <input className={`${baseClass} ${densityClass[density]} ${className}`} {...props} />;
}

export function Textarea({ density = "compact", className = "", ...props }: TextareaProps) {
  // Textareas size by min-height rather than the fixed control height.
  const sizing =
    density === "comfortable"
      ? "min-h-28 px-3 py-2.5 text-base leading-6"
      : "min-h-20 px-2.5 py-1.5 text-sm leading-5";
  return <textarea className={`${baseClass} ${sizing} ${className}`} {...props} />;
}

export function Select({ density = "compact", className = "", children, ...props }: SelectProps) {
  return (
    <select
      className={`${baseClass} ${densityClass[density]} ${selectPaddingClass[density]} ds-select appearance-none ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive-bg px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

export function FormSuccess({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="rounded-lg border border-success/30 px-3 py-2 text-sm text-success">{message}</p>
  );
}
