"use client";

import { useActionState, useState } from "react";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";
import { Card, Badge } from "@/components/ds/card";
import { Input, Field, FormError } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { Copy, Check, Key, Smartphone, Trash2, CheckCircle2 } from "lucide-react";

type ApiKeyItem = {
  id: string;
  name: string;
  userName: string | null;
  keyPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export function ApiKeysManager({
  keys,
  userName
}: {
  keys: ApiKeyItem[];
  userName?: string | null;
}) {
  const [state, formAction] = useActionState(createApiKeyAction, undefined);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [keyName, setKeyName] = useState("");

  const handleCopyKey = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  const handleCopyCurl = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Newly Created Key Alert */}
      {state?.ok && state.data && (
        <div className="rounded-xl border border-success/30 bg-success/10 p-4" role="status">
          <div className="flex items-center gap-2 text-sm font-semibold text-success">
            <CheckCircle2 className="h-4 w-4" />
            API Key Created Successfully
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Copy your secret key now. For your security, you will not be able to view the full key
            again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded-md bg-background px-3 py-2 font-mono text-xs font-semibold text-foreground ring-1 ring-border">
              {state.data.rawKey}
            </code>
            <button
              type="button"
              onClick={() => handleCopyKey(state.data!.rawKey)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {copiedKey ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedKey ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Generation Form */}
      <Card>
        <div className="mb-4">
          <h3 className="text-sm font-semibold">Generate new API key</h3>
          <p className="text-xs text-muted-foreground">
            Use API keys to connect iOS Shortcuts or Android automation directly to your Meridian
            ledger.
          </p>
        </div>

        <form
          action={async (formData) => {
            await formAction(formData);
            setKeyName("");
          }}
          className="space-y-3"
        >
          <Field label="Key name" htmlFor="key-name" hint="e.g., iPhone Shortcuts, Android Tasker">
            <div className="flex gap-2">
              <Input
                id="key-name"
                name="name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="iPhone SMS Shortcut"
                required
              />
              <SubmitButton variant="primary" className="whitespace-nowrap">
                Create Key
              </SubmitButton>
            </div>
          </Field>

          {state && !state.ok && <FormError message={state.error} />}
        </form>
      </Card>

      {/* Keys List */}
      <Card>
        <div className="mb-4">
          <h3 className="text-sm font-semibold">API Keys</h3>
          <p className="text-xs text-muted-foreground">
            You see your own keys
            {userName ? " and, as a family admin, every key in the household" : ""}. Keys grant
            access to record transactions into the family ledger.
          </p>
        </div>

        {keys.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No API keys created yet. Generate one above to get started.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {keys.map((k) => {
              const isRevoked = !!k.revokedAt;
              return (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Key className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{k.name}</span>
                      {k.userName && <Badge tone="neutral">{k.userName}</Badge>}
                      {isRevoked ? (
                        <Badge tone="destructive">Revoked</Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">{k.keyPrefix}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt && (
                        <span> • Last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                      )}
                    </p>
                  </div>

                  {!isRevoked && (
                    <form action={revokeApiKeyAction}>
                      <input type="hidden" name="keyId" value={k.id} />
                      <SubmitButton
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Revoke
                      </SubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* iOS Shortcuts & API Guide */}
      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">How to set up iOS Shortcuts</h3>
        </div>

        <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
          <ol className="list-decimal list-inside space-y-2">
            <li>
              Open the <strong>Shortcuts</strong> app on your iPhone and go to the{" "}
              <strong>Automation</strong> tab.
            </li>
            <li>
              Tap <strong>+</strong> &rarr; <strong>Message</strong>.
            </li>
            <li>
              Set <em>Sender</em> to your bank (e.g., <code>LAXMI</code>, <code>Nabil_Alert</code>,
              or <code>SBL_ALERT</code>) or leave as <em>Message Contains</em> &ldquo;debited&rdquo;
              / &ldquo;credited&rdquo;.
            </li>
            <li>
              Choose <strong>Run Immediately</strong> (turn off &ldquo;Notify When Run&rdquo;).
            </li>
            <li>
              In the action editor:
              <ul className="list-disc list-inside pl-4 mt-1 space-y-1">
                <li>
                  Add action: <strong>Ask for Input</strong> &rarr; &ldquo;What was this for?&rdquo;
                </li>
                <li>
                  Add action: <strong>Get Contents of URL</strong>:
                  <div className="mt-1 pl-4">
                    <p>
                      • URL: <code>https://YOUR_DOMAIN/api/v1/shortcuts/transaction</code>
                    </p>
                    <p>
                      • Method: <strong>POST</strong>
                    </p>
                    <p>
                      • Headers: <code>Authorization: Bearer YOUR_API_KEY</code>
                    </p>
                    <p>• Request Body (JSON):</p>
                    <pre className="mt-1 rounded bg-background p-2 font-mono text-[11px] text-foreground">
                      {`{
  "rawSms": Shortcut Input,
  "sender": Sender,
  "name": Provided Input
}`}
                    </pre>
                  </div>
                </li>
              </ul>
            </li>
          </ol>
        </div>

        <div className="mt-4 pt-3 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-foreground">Quick cURL test</span>
            <button
              type="button"
              onClick={() =>
                handleCopyCurl(
                  `curl -X POST "https://YOUR_DOMAIN/api/v1/shortcuts/transaction" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name": "Coffee", "amount": 150, "kind": "expense", "bank": "Nabil"}'`
                )
              }
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              {copiedCurl ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copiedCurl ? "Copied" : "Copy cURL"}
            </button>
          </div>
          <pre className="rounded-lg bg-background p-2.5 font-mono text-[11px] text-foreground overflow-x-auto ring-1 ring-border">
            {`curl -X POST "https://YOUR_DOMAIN/api/v1/shortcuts/transaction" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Coffee", "amount": 150, "kind": "expense", "bank": "Nabil"}'`}
          </pre>
        </div>
      </Card>
    </div>
  );
}
