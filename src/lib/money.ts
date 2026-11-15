import { errors } from "./errors";

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

const exponentCache = new Map<string, number>();

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  const cached = exponentCache.get(code);
  if (cached !== undefined) return cached;
  let exponent = 2;
  try {
    const opts = Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions();
    exponent = Math.max(0, Math.min(opts.maximumFractionDigits ?? 2, 4));
  } catch {
    exponent = 2;
  }
  exponentCache.set(code, exponent);
  return exponent;
}

export function isValidCurrency(code: string): boolean {
  try {
    const resolved = Intl.NumberFormat("en", {
      style: "currency",
      currency: code
    }).resolvedOptions();
    return /^[A-Z]{3}$/.test(code.toUpperCase()) && !!resolved.currency;
  } catch {
    return false;
  }
}

export const LIABILITY_TYPES = ["credit_card", "other_liability"] as const;

export function isLiability(type: string): boolean {
  return (LIABILITY_TYPES as readonly string[]).includes(type);
}

export function minorToDecimal(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const factor = 10 ** exp;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);
  if (exp === 0) return `${minor < 0 ? "-" : ""}${whole}`;
  const frac = (abs % factor).toString().padStart(exp, "0");
  return `${minor < 0 ? "-" : ""}${whole}.${frac}`;
}

export function minorToMajor(minor: number, currency: string): number {
  const exp = currencyExponent(currency);
  return minor / 10 ** exp;
}

export function displayToLedgerBalance(displayMinor: number, accountType: string): number {
  if (isLiability(accountType)) {
    return -Math.abs(displayMinor);
  }
  return displayMinor;
}

export function ledgerToDisplayBalance(ledgerMinor: number, accountType: string): number {
  if (isLiability(accountType)) {
    return -ledgerMinor;
  }
  return ledgerMinor;
}

function assertSafe(minor: number): void {
  if (!Number.isInteger(minor)) {
    throw errors.money("Money amounts must be integers in minor units.");
  }
  if (Math.abs(minor) > MAX_MINOR) {
    throw errors.money("Money amount exceeds the supported range.");
  }
}

export function parseAmountToMinor(input: string | number, currency: string): number {
  const raw = typeof input === "number" ? String(input) : input.trim();
  const cleaned = raw.replace(/[\s,_]/g, "");
  if (!/^[-+]?\d*(\.\d*)?$/.test(cleaned) || cleaned === "" || cleaned === "-" || cleaned === "+") {
    throw errors.money(`"${raw}" is not a valid amount.`);
  }
  const negative = cleaned.startsWith("-");
  const unsigned = cleaned.replace(/^[-+]/, "");
  const [wholePart, fracPartRaw = ""] = unsigned.split(".");
  const exp = currencyExponent(currency);
  if (exp > 0 && fracPartRaw.replace(/0+$/, "").length > exp) {
    throw errors.money(`"${raw}" carries more precision than ${currency} supports.`);
  }
  if (exp === 0 && fracPartRaw !== "" && Number(fracPartRaw) > 0) {
    throw errors.money(`"${raw}" carries more precision than ${currency} supports.`);
  }
  const fracPart = (fracPartRaw + "0".repeat(exp)).slice(0, exp);
  const whole = wholePart === "" ? 0 : Number(wholePart);
  const frac = exp === 0 ? 0 : Number(fracPart);
  const minor = whole * 10 ** exp + frac;
  assertSafe(minor);
  return negative ? -minor : minor;
}

/**
 * Non-throwing variant of {@link parseAmountToMinor} for form fields: returns
 * null while the text is empty, partial (e.g. "-"), over-precise for the
 * currency, or otherwise not yet a valid amount, so inputs can surface a
 * validation state instead of
 * throwing on every keystroke.
 */
export function tryParseAmountToMinor(input: string, currency: string): number | null {
  if (input.trim() === "") return null;
  try {
    return parseAmountToMinor(input, currency);
  } catch {
    return null;
  }
}

export function addMinor(a: number, b: number): number {
  assertSafe(a);
  assertSafe(b);
  const result = a + b;
  assertSafe(result);
  return result;
}

export function sumMinors(values: number[]): number {
  let acc = 0;
  for (const v of values) {
    acc = addMinor(acc, v);
  }
  return acc;
}

export function negateMinor(a: number): number {
  assertSafe(a);
  return -a;
}

export function formatMoney(
  minor: number,
  currency: string,
  locale = "en",
  opts: { signDisplay?: Intl.NumberFormatOptions["signDisplay"] } = {}
): string {
  assertSafe(minor);
  const exp = currencyExponent(currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
    signDisplay: opts.signDisplay ?? "auto"
  });
  return formatter.format(minor / 10 ** exp);
}

export function formatMoneySignedImpact(
  ledgerAmount: number,
  currency: string,
  locale = "en"
): string {
  return formatMoney(-ledgerAmount, currency, locale, { signDisplay: "always" });
}

export function splitEvenly(minorTotal: number, parts: number): number[] {
  assertSafe(minorTotal);
  if (parts < 1 || !Number.isInteger(parts))
    throw errors.money("Parts must be a positive integer.");
  const sign = minorTotal < 0 ? -1 : 1;
  const abs = Math.abs(minorTotal);
  const base = Math.floor(abs / parts);
  const remainder = abs % parts;
  const out: number[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(sign * (base + (i < remainder ? 1 : 0)));
  }
  return out;
}
