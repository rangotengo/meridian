"use client";

import { useRef, useState } from "react";
import { quickAddAction } from "./actions";
import { Input, Select, FormError } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { TagPicker } from "@/components/ds/tag-picker";
import { useDraftResyncOnError } from "@/components/finance/use-draft-resync";
import { Check } from "lucide-react";

export function QuickAddForm({
  accounts,
  categories,
  tags,
  today,
  onSaved,
  onCancel
}: {
  accounts: { id: string; name: string; currency: string }[];
  categories: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  today: string;
  /**
   * Dialog hosts (e.g. the dashboard Quick actions shortcut) pass this to
   * take over the success path — close + refresh — instead of the
   * standalone page's reset-and-flash rapid-entry cycle. The standalone
   * /quick-add page passes nothing and keeps its current behavior.
   */
  onSaved?: () => void;
  /** Dialog hosts pass this to render a Cancel button that closes. */
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [savedFlash, setSavedFlash] = useState(false);
  const [state, setState] = useState<{ ok: boolean; error?: string } | undefined>(undefined);
  const amountRef = useRef<HTMLInputElement>(null);

  // Every field is controlled, for the same reason as the transaction
  // composer: React resets UNCONTROLLED inputs when a form action
  // resolves, so a { ok: false } result from quickAddAction would wipe
  // the draft (amount and description cleared, account/category/tags
  // back to their defaults) even though the error is shown. Controlled
  // state survives the reset, and the resync hook re-applies it to any
  // control the reset desynced before the error render settles.
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  useDraftResyncOnError(state);

  async function handleAction(formData: FormData) {
    const result = await quickAddAction(undefined, formData);
    setState(result);
    if (result.ok) {
      if (onSaved) {
        onSaved();
        return;
      }
      // Standalone rapid entry: an explicit reset of the controlled
      // draft (a form reset() cannot clear controlled fields), then
      // focus back on Amount for the next entry.
      setAmount("");
      setName("");
      setAccountId(accounts[0]?.id ?? "");
      setCategoryId("");
      setTagIds([]);
      setKind("expense");
      amountRef.current?.focus();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    }
  }

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add an account first, then come back to record transactions.
      </p>
    );
  }

  return (
    <form action={handleAction} className="space-y-4">
      <FormError message={state?.ok === false ? state.error : undefined} />
      {savedFlash ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2 text-sm font-medium text-success">
          <Check className="h-4 w-4" />
          Saved
        </p>
      ) : null}

      <div
        className="grid grid-cols-2 gap-1 rounded-lg bg-surface-inset p-1"
        role="group"
        aria-label="Transaction type"
      >
        {(["expense", "income"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-md px-3 py-2.5 text-sm font-medium capitalize transition-colors ${
              kind === k
                ? "bg-surface text-primary shadow-sm"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      <input type="hidden" name="kind" value={kind} />

      <label className="block space-y-1">
        <span className="text-sm font-medium">Amount</span>
        <input
          ref={amountRef}
          name="amount"
          required
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="w-full rounded-md border border-border bg-surface px-3 py-4 text-2xl tabular shadow-sm outline-none transition-[border-color,box-shadow] focus:border-primary focus:ring-4 focus:ring-primary/10"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Description</span>
        <Input
          name="name"
          required
          maxLength={240}
          placeholder="Coffee"
          autoComplete="off"
          density="comfortable"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Account</span>
        <Select
          name="accountId"
          required
          density="comfortable"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Category (optional)</span>
        <Select
          name="categoryId"
          density="comfortable"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
        >
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>

      <TagPicker tags={tags} selected={tagIds} onSelectedChange={setTagIds} />

      <input type="hidden" name="date" value={today} />

      <SubmitButton className="w-full py-3 text-base">Save transaction</SubmitButton>
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
        >
          Cancel
        </button>
      ) : null}
    </form>
  );
}
