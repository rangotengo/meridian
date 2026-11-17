/**
 * Pure helpers for the global keyboard shortcuts.
 *
 * Single-key shortcuts must never fire while the user is typing, so every
 * resolution takes the event target into account. Cmd/Ctrl+K is the one
 * exception: it toggles the palette from anywhere, including inputs.
 */

export type PaletteShortcutAction = "toggle-palette" | "new-transaction" | "quick-add";

export type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
};

/** True when the event target is a field the user may be typing in. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  // Structural check (no HTMLElement/document dependency) so this stays
  // usable in non-DOM runtimes and unit tests.
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * Resolve a keydown to a palette action, or null when the key is not a
 * shortcut (or the user is typing and the shortcut must not fire).
 */
export function resolvePaletteShortcut(event: ShortcutEvent): PaletteShortcutAction | null {
  const { key, metaKey, ctrlKey, altKey, shiftKey } = event;
  if (altKey) return null;
  if ((metaKey || ctrlKey) && key.toLowerCase() === "k") return "toggle-palette";
  if (metaKey || ctrlKey || shiftKey) return null;
  if (isEditableTarget(event.target)) return null;
  if (key === "/") return "toggle-palette";
  if (key === "n" || key === "N") return "new-transaction";
  if (key === "q" || key === "Q") return "quick-add";
  return null;
}
