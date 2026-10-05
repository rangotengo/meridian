import { hashToken } from "@/lib/crypto";
import { currencyExponent } from "@/lib/money";

export type ParsedSmsResult = {
  amountMinor: number;
  amountMajor: number;
  currency: string;
  kind: "expense" | "income";
  date: string; // YYYY-MM-DD
  dateExplicit: boolean; // true when the SMS itself carried a parseable date
  accountNumber: string | null;
  accountDigits: string | null; // Just the unmasked digits for matching
  bankName: string | null;
  remarks: string | null;
  merchant: string | null;
  referenceId: string | null;
  rawText: string;
};

// Map of common SMS sender headers in Nepal & elsewhere to bank names
const KNOWN_SENDER_BANKS: Record<string, string> = {
  laxmi: "Laxmi Sunrise",
  laxmi_bank: "Laxmi Sunrise",
  nabil: "Nabil Bank",
  nabil_alert: "Nabil Bank",
  nbank: "Nabil Bank",
  sbl: "Siddhartha Bank",
  sbl_alert: "Siddhartha Bank",
  siddhartha: "Siddhartha Bank",
  nica: "NIC Asia Bank",
  nic_asia: "NIC Asia Bank",
  gbime: "Global IME Bank",
  global_ime: "Global IME Bank",
  ebl: "Everest Bank",
  kbl: "Kumari Bank",
  sanima: "Sanima Bank",
  prabhu: "Prabhu Bank",
  nmb: "NMB Bank",
  hbl: "Himalayan Bank",
  scb: "Standard Chartered Bank",
  scbn: "Standard Chartered Bank",
  czbil: "Citizens Bank",
  mbl: "Machhapuchchhre Bank",
  adbl: "Agricultural Development Bank",
  rbb: "Rastriya Banijya Bank",
  nbl: "Nepal Bank"
};

const KNOWN_BODY_BANKS = [
  "Laxmi Sunrise",
  "Siddhartha Bank",
  "Nabil Bank",
  "NIC Asia",
  "Global IME",
  "Everest Bank",
  "Kumari Bank",
  "Sanima Bank",
  "Prabhu Bank",
  "NMB Bank",
  "Himalayan Bank",
  "Standard Chartered",
  "Citizens Bank",
  "Machhapuchchhre Bank",
  "Nepal Bank"
];

function normalizeDate(rawDate: string): string | null {
  const trimmed = rawDate.trim();
  // Match DD/MM/YYYY or DD/MM/YY or DD-MM-YYYY or DD-MM-YY
  const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy && dmy[1] && dmy[2] && dmy[3]) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    let year = dmy[3];
    if (year.length === 2) {
      year = `20${year}`;
    }
    return `${year}-${month}-${day}`;
  }

  // Match YYYY-MM-DD
  const ymd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd && ymd[1] && ymd[2] && ymd[3]) {
    return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  }

  return null;
}

function getTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Converts a decimal amount string to minor units using the currency's real
 * exponent (e.g. 0 for JPY/KRW, 3 for BHD) instead of assuming two decimals.
 * Extra precision beyond the exponent is rounded half away from zero.
 */
export function amountTextToMinor(text: string, currency: string): number {
  const exp = currencyExponent(currency);
  const cleaned = text.replace(/[\s,]/g, "");
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole = "0", fracRaw = ""] = unsigned.split(".");
  // One extra digit beyond the exponent decides rounding.
  const padded = (fracRaw + "0".repeat(exp + 1)).slice(0, exp + 1);
  const kept = exp === 0 ? 0 : Number(padded.slice(0, exp));
  const roundDigit = Number(padded.slice(exp, exp + 1) || "0");
  let minor = Number(whole || "0") * 10 ** exp + kept;
  if (roundDigit >= 5) minor += 1;
  return negative ? -minor : minor;
}

export function parseSms(text: string, sender?: string | null): ParsedSmsResult {
  const clean = text.trim();

  // 1. Determine Kind (expense vs income)
  // Check income terms
  const isCredited =
    /\b(credited|deposited|deposit|received|refund|reversal|cashback|cr\.?)\b/i.test(clean) ||
    /fund trf frm/i.test(clean);

  // Check expense terms
  const isDebited =
    /\b(withdrawn|debited|spent|spend|purchased|purchase|paid|deducted|charged|dr\.?)\b/i.test(
      clean
    ) || /fund trf to/i.test(clean);

  let kind: "expense" | "income" = "expense";
  if (isCredited && !isDebited) {
    kind = "income";
  } else if (isDebited) {
    kind = "expense";
  } else if (isCredited) {
    kind = "income";
  }

  // 2. Extract Currency & Amount
  let currency = "NPR";
  if (/\b(usd|\$)\b/i.test(clean)) currency = "USD";
  else if (/\b(eur|€)\b/i.test(clean)) currency = "EUR";
  else if (/\b(gbp|£)\b/i.test(clean)) currency = "GBP";
  else if (/\b(inr|₹)\b/i.test(clean)) currency = "INR";
  else if (/\b(jpy|¥)\b/i.test(clean)) currency = "JPY";
  else if (/\b(npr|rs\.?|nrs\.?|रू)\b/i.test(clean)) currency = "NPR";

  let amountMajor = 0;
  let amountText: string | null = null;

  // Specific regex for action + amount or amount + action
  const actionAmountRegexes = [
    /(?:credited|debited|withdrawn|deposited|charged|spent|received|paid)\s+(?:by|for|of)?\s*(?:NPR|Rs\.?|NRs\.?|INR|JPY|¥|USD|\$|EUR|€|GBP|£)?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,4})?)/i,
    /(?:NPR|Rs\.?|NRs\.?|INR|JPY|¥|USD|\$|EUR|€|GBP|£)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,4})?)\s*(?:has been\s+)?(?:credited|debited|withdrawn|deposited|charged|spent|received|paid)/i,
    /(?:NPR|Rs\.?|NRs\.?|INR|JPY|¥|USD|\$|EUR|€|GBP|£)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,4})?)/i
  ];

  for (const regex of actionAmountRegexes) {
    const match = clean.match(regex);
    if (match?.[1]) {
      const parsedNum = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(parsedNum) && parsedNum > 0) {
        amountMajor = parsedNum;
        amountText = match[1];
        break;
      }
    }
  }

  // If still no amount, look for any decimal number
  if (amountMajor === 0) {
    const fallback = clean.match(/\b([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\b/);
    if (fallback?.[1]) {
      amountMajor = parseFloat(fallback[1].replace(/,/g, ""));
      amountText = fallback[1];
    }
  }

  // Minor units derived with the detected currency's real exponent
  // (e.g. JPY has 0 decimals, so "JPY 1000" is 1000 minor, not 100000).
  const amountMinor = amountText ? amountTextToMinor(amountText, currency) : 0;

  // 3. Extract Date
  let date = getTodayIso();
  let dateExplicit = false;
  const dateMatch = clean.match(/(?:on|dated)?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i);
  if (dateMatch?.[1]) {
    const normalized = normalizeDate(dateMatch[1]);
    if (normalized) {
      date = normalized;
      dateExplicit = true;
    }
  }

  // 4. Extract Account Number / Identifier
  let accountNumber: string | null = null;
  let accountDigits: string | null = null;

  const acctMatch =
    clean.match(/(?:Your\s+#?|AC\s+|A\/C\s+|account\s+|acct\s+)([0-9A-Za-z#*]{4,})/i) ||
    clean.match(/#([0-9A-Za-z#*]{4,})/i);

  if (acctMatch?.[1]) {
    accountNumber = acctMatch[1].trim();
    const digitMatch = accountNumber.match(/([0-9]{3,})/g);
    if (digitMatch && digitMatch.length > 0) {
      accountDigits = digitMatch[digitMatch.length - 1] ?? null;
    }
  }

  // 5. Extract Bank Name
  let bankName: string | null = null;

  if (sender) {
    const cleanSender = sender
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    for (const [key, name] of Object.entries(KNOWN_SENDER_BANKS)) {
      if (cleanSender.includes(key)) {
        bankName = name;
        break;
      }
    }
  }

  if (!bankName) {
    for (const name of KNOWN_BODY_BANKS) {
      if (new RegExp(`\\b${name}\\b`, "i").test(clean)) {
        bankName = name;
        break;
      }
    }
  }

  // 6. Extract Remarks & Reference ID
  let remarks: string | null = null;
  let referenceId: string | null = null;
  let merchant: string | null = null;

  const remarksMatch = clean.match(/Remarks\s*:\s*([^\r\n]+)/i);
  if (remarksMatch?.[1]) {
    remarks = remarksMatch[1]
      .replace(/Download\s+App:.*$/i, "")
      .replace(/-(?:Laxmi|Siddhartha|Nabil).*$/i, "")
      .trim();
  }

  const forMatch = clean.match(/for\s+([^\r\n]+?)(?:\s+Download|\s+Siddhartha|\s+-Laxmi|$|\r|\n)/i);
  if (forMatch?.[1] && !remarks) {
    remarks = forMatch[1].trim();
  }

  if (remarks) {
    const refMatch =
      remarks.match(/\b([A-Za-z0-9_-]{10,})\b/) || remarks.match(/-([A-Za-z0-9]{8,})/);
    if (refMatch?.[1]) {
      referenceId = refMatch[1];
    }

    merchant = remarks.slice(0, 120);
  }

  if (!referenceId) {
    const generalRefMatch = clean.match(
      /(?:ref(?:erence)?(?:\s*no\.?)?|txn(?:\s*id)?)\s*[:#]?\s*([A-Za-z0-9_-]+)/i
    );
    if (generalRefMatch?.[1]) {
      referenceId = generalRefMatch[1];
    }
  }

  // Deterministic fallback for deduplication
  if (!referenceId && amountMinor > 0) {
    const rawHash = hashToken(clean).slice(0, 12);
    referenceId = `sms_${date}_${amountMinor}_${accountDigits ?? "acct"}_${rawHash}`;
  }

  return {
    amountMinor,
    amountMajor,
    currency,
    kind,
    date,
    dateExplicit,
    accountNumber,
    accountDigits,
    bankName,
    remarks,
    merchant,
    referenceId,
    rawText: clean
  };
}
