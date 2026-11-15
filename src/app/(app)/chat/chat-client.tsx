"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Send, Trash2, X } from "lucide-react";
import { clearChatAction } from "./actions";
import { fmtMoney } from "@/lib/format";
import { ConfirmDialog } from "@/components/ds/dialog";

export type ChatUiMessage = { role: "user" | "assistant"; content: string };

export type ChatProposal = {
  id: string;
  name: string;
  accountName: string;
  amountLedgerMinor: number;
  currency: string;
  date: string;
  merchant: string | null;
};

export function ChatClient({
  initialMessages,
  initialProposal,
  enabled,
  userName
}: {
  initialMessages: ChatUiMessage[];
  initialProposal: ChatProposal | null;
  enabled: boolean;
  userName: string;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatUiMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ChatProposal | null>(initialProposal);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy || !enabled) return;

    setMessages((m) => [...m, { role: "user", content: message }]);
    setInput("");
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message })
      });
      const data = (await res.json()) as {
        reply?: string;
        error?: string;
        proposal?: ChatProposal | null;
      };
      if (!res.ok || !data.reply) {
        setError(data.error ?? "The assistant could not respond.");
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply! }]);
        setProposal(data.proposal ?? null);
      }
    } catch {
      setError("Network error — could not reach the assistant.");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const confirmProposal = async () => {
    if (!proposal || busy || acting) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmProposalId: proposal.id })
      });
      const data = (await res.json()) as {
        recorded?: { note: string };
        error?: string;
      };
      if (!res.ok || !data.recorded) {
        setError(data.error ?? "Could not record that transaction.");
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.recorded!.note }]);
        setProposal(null);
        router.refresh();
      }
    } catch {
      setError("Network error — could not record that transaction.");
    } finally {
      setActing(false);
      inputRef.current?.focus();
    }
  };

  const cancelProposal = async () => {
    if (!proposal || acting) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dismissProposalId: proposal.id })
      });
      if (res.ok) {
        setProposal(null);
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Could not discard that proposal.");
        setProposal(null);
      }
    } catch {
      setProposal(null);
    } finally {
      setActing(false);
      inputRef.current?.focus();
    }
  };

  const clear = async () => {
    await clearChatAction();
    setMessages([]);
  };

  if (!enabled) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-fg">
            M
          </div>
          <div>
            <h1 className="text-lg font-medium">Assistant</h1>
            <p className="text-xs text-muted-foreground">Your financial copilot</p>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          AI chat is not configured. Set{" "}
          <code className="rounded bg-border/50 px-1">AI_BASE_URL</code> and{" "}
          <code className="rounded bg-border/50 px-1">AI_MODEL</code> environment variables (any
          OpenAI-compatible endpoint: Ollama, LM Studio, OpenRouter, OpenAI…), then restart.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-fg">
            M
          </div>
          <div>
            <h1 className="text-base font-medium">Assistant</h1>
            <p className="text-xs text-muted-foreground">Ask about your money</p>
          </div>
        </div>
        {messages.length > 0 ? (
          <ConfirmDialog
            trigger={
              <span
                className="flex items-center gap-1.5 rounded-lg p-2 text-muted-foreground hover:bg-border/40 hover:text-destructive"
                title="Clear conversation"
              >
                <Trash2 className="h-4 w-4" />
                <span className="text-xs font-medium">Clear</span>
              </span>
            }
            title="Clear this conversation?"
            description="Chat history is deleted. Unconfirmed proposals are discarded."
            confirmLabel="Clear conversation"
            action={async () => {
              await clear();
            }}
          />
        ) : null}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4 pb-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-fg">
              M
            </div>
            <p className="mt-4 text-lg font-medium">Hello {userName.split(" ")[0]} 👋</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Ask about your spending, net worth, income — or ask me to record a transaction.
            </p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {[
                "How much did I spend on groceries this month?",
                "What's my net worth right now?",
                "Compare this month's spending to last month",
                "Add $4.50 coffee from this morning"
              ].map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-xl bg-surface px-4 py-2.5 text-left text-sm shadow-sm transition-colors hover:bg-surface-hover"
                  onClick={() => {
                    setInput(s);
                    inputRef.current?.focus();
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${
                  m.role === "user" ? "bg-primary text-primary-fg" : "bg-surface-inset shadow-sm"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {busy ? (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-surface-inset px-4 py-2.5 text-sm text-muted-foreground shadow-sm">
              Thinking…
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="rounded-lg bg-destructive-bg px-3 py-2 text-sm text-destructive">{error}</p>
        ) : null}
        {proposal ? (
          <div className="rounded-xl border border-border bg-surface-inset p-3 shadow-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Proposed transaction — not saved yet
            </p>
            <p className="mt-1 text-sm font-medium">{proposal.name}</p>
            <p className="text-sm">
              {fmtMoney(proposal.amountLedgerMinor, proposal.currency)} · {proposal.accountName} ·{" "}
              {proposal.date}
              {proposal.merchant ? ` · ${proposal.merchant}` : ""}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={confirmProposal}
                disabled={acting}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" />
                Confirm
              </button>
              <button
                type="button"
                onClick={cancelProposal}
                disabled={acting}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
                Discard
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <form onSubmit={send} className="border-t border-border bg-surface p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Don't send while an IME composition is active: the Enter
              // that confirms a candidate would otherwise send a
              // half-composed message. keyCode 229 is the legacy signal
              // some browsers still report for composition keydowns.
              const composing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
              if (e.key === "Enter" && !e.shiftKey && !composing) {
                e.preventDefault();
                void send(e);
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder="Ask anything about your money…"
            className="max-h-36 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
