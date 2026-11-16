"use client";

import { useEffect } from "react";
import {
  applyResolvedTheme,
  readBrowserThemePreference,
  resolveTheme,
  type ThemePreference
} from "@/lib/theme";

/**
 * Keeps the painted theme in sync while the preference is "system":
 * reacts to OS appearance changes and re-asserts the resolved theme
 * after mount (repairing any case where the pre-paint bootstrap could
 * not run). Explicit light/dark preferences are never touched — OS
 * changes must not override an explicit choice. Nothing is persisted
 * here; only explicit user actions write the preference.
 */
export function ThemeListener({ initialPreference }: { initialPreference: ThemePreference }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const preference = readBrowserThemePreference() ?? initialPreference;
      if (preference === "system") {
        applyResolvedTheme(resolveTheme("system", media.matches));
      }
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [initialPreference]);
  return null;
}
