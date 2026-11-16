"use client";

import { useEffect, useRef, useState } from "react";

/**
 * React resets form fields in the DOM when a form action resolves, and
 * controlled fields are only re-applied from state on the NEXT render —
 * so right after a { ok: false } result, some controls (a select, the
 * tag checkboxes) can visibly snap back to their defaults even though
 * their state still holds the draft. Force one extra render when a
 * failure result lands so every controlled field is re-synced from
 * state. The render must be scheduled after the error commit (React's
 * reset lands after a same-commit re-render, which is why this defers
 * by one frame instead of adjusting state during render). Verified
 * against React 19: a post-error re-render heals the desynced controls.
 * Shared by the transaction composer and Quick Add, whose drafts must
 * both survive a refused server action.
 */
export function useDraftResyncOnError(state: { ok: boolean } | undefined) {
  const [, setResyncTick] = useState(0);
  const seenState = useRef(state);
  useEffect(() => {
    if (seenState.current === state) return;
    seenState.current = state;
    if (state?.ok !== false) return;
    const frame = requestAnimationFrame(() => setResyncTick((t) => t + 1));
    return () => cancelAnimationFrame(frame);
  }, [state]);
}
