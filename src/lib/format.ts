import { formatIsoDate, formatMonthKey } from "./datetime";

export type FamilyFormatSettings = { locale: string; timezone: string; currency: string };

export function fmtMoney(
  minor: number,
  currency: string,
  locale = "en",
  signDisplay?: Intl.NumberFormatOptions["signDisplay"]
): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
    ...(signDisplay ? { signDisplay } : {})
  }).format(minor / 10 ** exp);
}

/**
 * Signed money for deltas: exactly one sign mechanism. Positive renders
 * "+…", negative renders "−…", zero renders with no sign. Callers must NOT
 * add their own "+" prefix — combining a manual prefix with a signed
 * format rendered "++…" (PR #22 review).
 */
export function fmtSignedMoney(minor: number, currency: string, locale = "en"): string {
  return fmtMoney(minor, currency, locale, "exceptZero");
}

function currencyExponent(currency: string): number {
  try {
    const opts = Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions();
    return Math.max(0, Math.min(opts.maximumFractionDigits ?? 2, 4));
  } catch {
    return 2;
  }
}

export function fmtDate(iso: string, settings?: Partial<FamilyFormatSettings>): string {
  return formatIsoDate(iso, settings?.locale ?? "en", undefined);
}

export function fmtMonth(monthKey: string, locale = "en"): string {
  return formatMonthKey(monthKey, locale);
}

/**
 * Signed percentage change for deltas: "+12.3%", "-4.0%", or an em dash
 * when the previous value was zero (null) or the ratio is not finite.
 * Single shared copy — the dashboard and reports delta rows previously
 * each carried an identical local definition (PR #26 follow-up).
 */
export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}%`;
}

export function fmtPercent(ratio: number, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    ratio
  );
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
