/**
 * Pure helpers that distil "recent" chips for Quick Add out of a page of
 * recent entries (most recent first). Nothing here touches the database —
 * callers fetch the entries once and reuse them for both lists.
 */

export type RecentEntryLike = {
  merchant: string | null;
  /**
   * Entry description. Quick Add saves merchant:null, so the description
   * is the only payee signal those entries carry — without it a
   * Quick Add-only user never builds recent payee chips.
   */
  name?: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

export type RecentPayee = { name: string; categoryId: string | null };

/**
 * Distinct payees from the most recent entries first, each with the
 * category its latest transaction used (so one tap can fill description
 * and category together). The stored merchant wins when present; entries
 * without one fall back to their description, so Quick Add entries
 * (merchant:null) build chips too, and choosing a chip refreshes that
 * payee recency — the saved entry is the most recent one carrying the
 * name, so it sorts first on the next visit.
 */
export function recentPayees(items: RecentEntryLike[], limit = 6): RecentPayee[] {
  const seen = new Set<string>();
  const out: RecentPayee[] = [];
  for (const item of items) {
    const name = item.merchant?.trim() || item.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, categoryId: item.categoryId });
    if (out.length >= limit) break;
  }
  return out;
}

export type RecentCategory = { id: string; name: string };

/** Distinct categories from the most recent entries first. */
export function recentCategories(items: RecentEntryLike[], limit = 6): RecentCategory[] {
  const seen = new Set<string>();
  const out: RecentCategory[] = [];
  for (const item of items) {
    if (!item.categoryId || !item.categoryName || seen.has(item.categoryId)) continue;
    seen.add(item.categoryId);
    out.push({ id: item.categoryId, name: item.categoryName });
    if (out.length >= limit) break;
  }
  return out;
}
