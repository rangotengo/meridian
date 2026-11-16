/**
 * Shared, pure logic for the transaction composer (the create-transaction /
 * create-transfer form used on /transactions/new and inside dialogs on the
 * account page and dashboard).
 *
 * This module is deliberately free of React and Next imports so the rules
 * can be unit-tested directly:
 *
 *  - how the /transactions/new?account=<id>&kind=<kind> entry parameters are
 *    parsed and validated, and
 *  - which accounts are compatible transfer destinations for a source.
 */

export type ComposerMode = "expense" | "income" | "transfer";

export type ComposerOption = { id: string; name: string };
export type ComposerAccountOption = ComposerOption & { currency: string };

const MODES: readonly ComposerMode[] = ["expense", "income", "transfer"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isComposerMode(value: string | null | undefined): value is ComposerMode {
  return value != null && (MODES as readonly string[]).includes(value);
}

/**
 * Validate the direct-entry parameters for the creation page. Anything
 * unrecognized falls back safely (expense mode, no preset account) — a
 * hand-edited or stale URL must never crash the page or preselect an
 * account the actor cannot use.
 *
 * `eligibleAccountIds` is the set of accounts the actor may create entries
 * on (active, full control); a preset naming anything else is ignored.
 */
export function parseComposerParams(
  raw: { account?: string | null; kind?: string | null },
  eligibleAccountIds: ReadonlySet<string>
): { initialAccountId: string; initialMode: ComposerMode } {
  const initialMode: ComposerMode = isComposerMode(raw.kind) ? raw.kind : "expense";
  const account = raw.account ?? "";
  const initialAccountId = UUID_RE.test(account) && eligibleAccountIds.has(account) ? account : "";
  return { initialAccountId, initialMode };
}

/**
 * Accounts a transfer may go TO from `sourceId`: every eligible account
 * except the source itself, in the source's currency. The list is derived
 * from the CURRENT source, so it must be recomputed whenever the source
 * changes. The domain enforces the same rules server-side; this list only
 * shapes what the form offers.
 */
export function compatibleDestinations(
  accounts: ComposerAccountOption[],
  sourceId: string
): ComposerAccountOption[] {
  const source = accounts.find((a) => a.id === sourceId);
  if (!source) return [];
  return accounts.filter((a) => a.id !== sourceId && a.currency === source.currency);
}
