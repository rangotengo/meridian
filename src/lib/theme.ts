/**
 * The single theme contract shared by the server layout, the pre-paint
 * bootstrap script, the header toggle, the command palette, and the
 * Appearance settings form.
 *
 * A *preference* is what the user chose: "light" | "dark" | "system".
 * A *resolved* theme is what is actually painted: "light" | "dark".
 * The preference is persisted in the `theme` cookie (browser preference)
 * and mirrored to the user's saved preference server-side. The resolved
 * theme is expressed as the `dark` class on <html> (plus the matching
 * `color-scheme` in CSS).
 *
 * Precedence: a valid browser preference wins; a saved user preference
 * initializes a missing browser preference; "system" is the fallback.
 * Only explicit user choices are persisted — rendering, refreshing, and
 * OS appearance changes never write the preference.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_COOKIE_NAME = "theme";
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Parse a raw cookie/preference value; null when missing or invalid. */
export function parseThemePreference(value: string | null | undefined): ThemePreference | null {
  return isThemePreference(value) ? value : null;
}

/** Apply the precedence contract: browser > saved > system. */
export function chooseThemePreference(
  browser: ThemePreference | null,
  saved: ThemePreference | null
): ThemePreference {
  return browser ?? saved ?? "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return prefersDark ? "dark" : "light";
}

/** The inline pre-paint bootstrap, rendered by the root layout. */
export function themeBootstrapScript(preference: ThemePreference): string {
  return `(function(){try{var t=${JSON.stringify(preference)};var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var dark=t==="dark"||(t==="system"&&d);document.documentElement.classList.toggle("dark",dark);}catch(e){}})();`;
}

// ---------------------------------------------------------------------------
// Client-only helpers (browser globals). Server code must use the pure
// functions above so the contract stays identical on both sides.
// ---------------------------------------------------------------------------

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Read the browser preference from the cookie; null when unset/invalid. */
export function readBrowserThemePreference(): ThemePreference | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${THEME_COOKIE_NAME}=(light|dark|system)(?:;|$)`)
  );
  return match ? (match[1] as ThemePreference) : null;
}

/** Paint a resolved theme. Never persists anything. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * Record an explicit user choice: paint it and persist it to the cookie.
 * The server actions invoked alongside this also mirror it to the user's
 * saved preference. This is the ONLY client path that writes the cookie.
 */
export function applyTheme(theme: ThemePreference): void {
  applyResolvedTheme(resolveTheme(theme, systemPrefersDark()));
  document.cookie = `${THEME_COOKIE_NAME}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}
