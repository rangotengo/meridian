/**
 * Pure helpers for command-palette search.
 *
 * The palette caps rendered rows per group so a long list never floods
 * the dialog — but the cap applies AFTER filtering, never before.
 * Slicing the full list first hid every match past the cap (PR #23
 * review: searching for category 13 found nothing because only the
 * first 12 categories were rendered for cmdk to filter).
 */

export const PALETTE_RESULT_LIMIT = 12;

/**
 * Case-insensitive substring match across any of the given texts.
 * An empty query matches everything.
 */
export function matchesQuery(texts: (string | null | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return texts.some((text) => text != null && text.toLowerCase().includes(q));
}

export type FilteredResults<T> = {
  /** Rows to render (at most `limit`). */
  shown: T[];
  /** Matches in the full list, before the render cap. */
  total: number;
};

/**
 * Filter the FULL list by query, then cap the rendered rows. Callers
 * should surface `total` when it exceeds `shown.length` so the user
 * knows to refine the search instead of assuming there are no more
 * matches.
 */
export function filterAndLimit<T>(
  items: T[],
  query: string,
  textOf: (item: T) => (string | null | undefined)[],
  limit: number = PALETTE_RESULT_LIMIT
): FilteredResults<T> {
  const matched = items.filter((item) => matchesQuery(textOf(item), query));
  return { shown: matched.slice(0, limit), total: matched.length };
}
