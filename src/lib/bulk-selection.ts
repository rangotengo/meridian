/**
 * Pure helpers for bulk selection on the transactions list. Selection is a
 * plain array of entry ids; order is the order rows were selected in.
 *
 * Selection is scoped to the visible page: the list remounts with fresh
 * state on page/filter changes (see page.tsx listKey), and the component
 * only ever shows or submits ids on the current page — so a selection can
 * never grow past the 25 ids the bulk-delete action accepts, even if rows
 * were selected on an earlier page before a revalidation.
 */

/** Toggle one id in the selection. */
export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** Add every id on the current page that is not already selected. */
export function selectAllOnPage(selected: string[], pageIds: string[]): string[] {
  const next = [...selected];
  for (const id of pageIds) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

/** Remove every id on the current page from the selection. */
export function deselectAllOnPage(selected: string[], pageIds: string[]): string[] {
  const page = new Set(pageIds);
  return selected.filter((id) => !page.has(id));
}

/** One-line summary of a bulk delete outcome for the result banner. */
export function formatBulkDeleteSummary(deletedCount: number, skippedCount: number): string {
  const deleted =
    deletedCount === 1 ? "Deleted 1 transaction." : `Deleted ${deletedCount} transactions.`;
  if (skippedCount === 0) return deleted;
  const skipped =
    skippedCount === 1
      ? "1 transaction was skipped."
      : `${skippedCount} transactions were skipped.`;
  return `${deleted} ${skipped}`;
}
