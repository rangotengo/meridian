/**
 * The MCP read-only scope set. Scopes are issued by Meridian's own
 * authorization server and enforced inside tool handlers — never merely
 * advertised. Nothing outside this list is ever granted, and no scope in
 * this list permits a write.
 */
export const MCP_READ_SCOPES = ["finance:read", "transactions:read", "transactions:notes"] as const;

/** offline_access is the OAuth refresh-token scope; it is advertised in
 * authorization-server metadata only (per the 2025-11-25 MCP profile it
 * stays out of protected-resource metadata). */
export const MCP_ALL_SCOPES = [...MCP_READ_SCOPES, "offline_access"] as const;

/** Granted when a client does not request scopes explicitly. */
export const MCP_DEFAULT_SCOPES: string[] = ["finance:read", "transactions:read"];

/** Short plain-language labels for compact surfaces (the Connected AI
 * agents settings page). The consent page uses SCOPE_DESCRIPTIONS; both
 * maps live here so scope wording is defined in exactly one place. */
export const SCOPE_LABELS: Record<string, string> = {
  "finance:read": "View balances, summaries, budgets and trends",
  "transactions:read": "View transactions",
  "transactions:notes": "View transaction notes",
  offline_access: "Stay connected between sessions"
};

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "finance:read":
    "Read financial summaries: net worth, balances, budgets, income and expense totals.",
  "transactions:read":
    "Search and read transactions (dates, amounts, categories, merchants — not free-text notes).",
  "transactions:notes": "Also read the free-text notes attached to transactions.",
  offline_access: "Stay connected over time (refresh tokens) instead of reconnecting every hour."
};

/**
 * The scope each tool requires, enforced inside its handler. This map is
 * the single source the handlers follow; the authorization server issues
 * exactly MCP_READ_SCOPES, so every scope named here is issuable.
 */
export const TOOL_SCOPES = {
  get_financial_summary: "finance:read",
  list_accounts: "finance:read",
  search_transactions: "transactions:read",
  get_spending_breakdown: "finance:read",
  get_income_expense_trend: "finance:read",
  get_budget_progress: "finance:read",
  list_recurring_transactions: "finance:read",
  get_net_worth_history: "finance:read"
} as const;

/**
 * Extra scope the merchant grouping of get_spending_breakdown requires:
 * merchant strings are transaction text, like search results.
 */
export const BREAKDOWN_MERCHANT_SCOPE = "transactions:read";

/** Scope that unlocks free-text entry notes in transaction results. */
export const NOTES_SCOPE = "transactions:notes";

export function isKnownScope(scope: string): boolean {
  return (MCP_ALL_SCOPES as readonly string[]).includes(scope);
}

/** Validate a requested scope string down to the known set. Unknown scopes
 * are rejected by the caller when `rejectUnknown` is set (authorize time);
 * at token/consent time unknown entries are simply never granted. */
export function parseScopeParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/\s+/).filter(Boolean))];
}
