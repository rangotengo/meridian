"use client";

import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import { SubmitButton } from "./submit-button";
import { FormError } from "./form";

const DialogCloseContext = createContext<(() => void) | null>(null);

export function useDialogClose(): () => void {
  const close = useContext(DialogCloseContext);
  if (!close) throw new Error("useDialogClose must be used within a Dialog");
  return close;
}

export function Dialog({
  trigger,
  title,
  description,
  children,
  width = "max-w-lg",
  onOpen
}: {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  width?: string;
  /** Called each time the dialog is opened (e.g. to reset stale form state). */
  onOpen?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
  }, []);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClose = () => {
      // Focus returns to the very control that opened the dialog. The
      // trigger element is a real tab stop (see below), so this works for
      // keyboard and pointer users alike.
      triggerRef.current?.focus();
    };
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  const open = () => {
    onOpen?.();
    ref.current?.showModal();
  };
  const close = () => ref.current?.close();

  // Accessible trigger API: the caller's element IS the control — the
  // Dialog forwards the open behavior, a ref, and (for elements that are
  // not natively interactive) button semantics onto it instead of
  // wrapping it in a `display: contents` button. A contents wrapper
  // generates no box, so Chromium drops it from the tab order entirely:
  // the shortcuts were mouse-only, and focus "restoration" on close could
  // only park focus on the child span with tabindex=-1, which Tab still
  // skipped. Enhancing the element itself keeps every caller's layout
  // untouched (the styled span stays the layout box) while making it a
  // genuine tab stop that Enter/Space activate.
  type TriggerProps = {
    className?: string;
    role?: string;
    tabIndex?: number;
    onClick?: (event: ReactMouseEvent) => void;
    onKeyDown?: (event: ReactKeyboardEvent) => void;
  };
  const triggerElement = (
    isValidElement(trigger) ? trigger : <span>{trigger}</span>
  ) as ReactElement<TriggerProps>;
  const triggerProps = triggerElement.props;
  const nativelyInteractive =
    typeof triggerElement.type === "string" &&
    (triggerElement.type === "button" || triggerElement.type === "a");
  const TriggerTag = triggerElement.type as React.ElementType;
  const triggerButtonProps = nativelyInteractive
    ? {}
    : {
        role: "button",
        tabIndex: triggerProps.tabIndex ?? 0,
        onKeyDown: (event: ReactKeyboardEvent) => {
          triggerProps.onKeyDown?.(event);
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        }
      };

  return (
    <DialogCloseContext.Provider value={close}>
      <TriggerTag
        {...triggerProps}
        ref={setTriggerRef}
        className={[triggerProps.className, "cursor-pointer"].filter(Boolean).join(" ")}
        onClick={(event: ReactMouseEvent) => {
          triggerProps.onClick?.(event);
          open();
        }}
        {...triggerButtonProps}
      />
      <dialog
        ref={ref}
        closedby="any"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={`backdrop:bg-black/40 open:flex open:flex-col m-auto rounded-xl border border-border bg-surface p-0 text-fg shadow-xl ${width} w-[calc(100vw-2rem)]`}
      >
        <div className="flex flex-col gap-1 border-b border-border p-5">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close dialog"
              className="rounded-md p-1 text-muted-foreground hover:bg-border/50 hover:text-foreground"
            >
              ✕
            </button>
          </div>
          {description ? (
            <p id={descId} className="text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        <div className="p-5">{children}</div>
      </dialog>
    </DialogCloseContext.Provider>
  );
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "destructive",
  action,
  children
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "destructive" | "secondary";
  action: (formData: FormData) => void | Promise<unknown>;
  children?: React.ReactNode;
}) {
  return (
    <Dialog trigger={trigger} title={title} description={description}>
      <ConfirmForm action={action} confirmLabel={confirmLabel} variant={variant}>
        {children}
      </ConfirmForm>
    </Dialog>
  );
}

function ConfirmForm({
  action,
  confirmLabel,
  variant,
  children
}: {
  action: (formData: FormData) => void | Promise<unknown>;
  confirmLabel: string;
  variant: "destructive" | "secondary";
  children?: React.ReactNode;
}) {
  const close = useDialogClose();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (formData: FormData) => {
    setError(null);
    const res = await action(formData);
    if (res && typeof res === "object" && "ok" in res && !res.ok) {
      const msg = "error" in res && typeof res.error === "string" ? res.error : "Action failed";
      setError(msg);
      return;
    }
  };

  return (
    <form action={handleSubmit} className="flex flex-col gap-3">
      {error ? <FormError message={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {children}
        <button
          type="button"
          onClick={close}
          className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
        >
          Cancel
        </button>
        <SubmitButton variant={variant}>{confirmLabel}</SubmitButton>
      </div>
    </form>
  );
}
