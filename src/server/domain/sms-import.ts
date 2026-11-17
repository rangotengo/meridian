import { and, desc, eq, isNotNull, max, ne, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { accounts, categories, entries, transactions } from "../db/schema";
import type { Actor, Family } from "../auth/context";
import { parseSms, type ParsedSmsResult } from "./sms-parser";
import { matchAccountForSms } from "./account-matcher";
import { addTransaction } from "./orchestrate";
import { findEntryByExternalId, MAX_NAME_LENGTH } from "./entries";
import { parseAmountToMinor } from "@/lib/money";
import { isIsoDate, todayIn } from "@/lib/datetime";
import { errors } from "@/lib/errors";

/**
 * Dedupe identity for bank/wallet SMS imports. The identity is the SMS
 * reference id (parsed from the message, or the deterministic `sms_…`
 * fallback the parser builds from amount + account digits + text hash —
 * plus the SMS's own date when it carried one; a defaulted "today" is
 * never part of the identity, so the same undated text dedupes the same
 * way tomorrow). Entries recorded before that change carry a legacy
 * dated fallback id; the entry layer recognises those by their hash
 * tail. Stored as the entry's externalId under this source. The web
 * import deliberately reuses the Shortcuts flow's source string, so the
 * same SMS can never be recorded twice no matter which path recorded it
 * first — a second import of the same SMS reports "already recorded"
 * instead of creating a second transaction.
 */
export const SMS_EXTERNAL_SOURCE = "sms_shortcut";

export type SmsAccountSuggestion = {
  id: string;
  name: string;
  institution: string | null;
  currency: string;
  matchedBy: string;
};

export type SmsCategorySuggestion = {
  id: string;
  name: string;
  useCount: number;
};

export type SmsImportPreview = {
  parsed: {
    amountMinor: number;
    amountMajor: number;
    currency: string;
    kind: "expense" | "income";
    date: string;
    dateExplicit: boolean;
    accountDigits: string | null;
    bankName: string | null;
    remarks: string | null;
    merchant: string | null;
    referenceId: string | null;
  };
  account: SmsAccountSuggestion | null;
  suggestedCategory: SmsCategorySuggestion | null;
  /** Entry id when this SMS was already recorded (same reference id). */
  duplicateEntryId: string | null;
  /** True when the SMS currency differs from the matched account's. */
  currencyMismatch: boolean;
};

/**
 * Suggests a category from the household's own history: the category most
 * often used with this merchant (exact match, case-insensitive) on the
 * actor's visible accounts. Transfer legs and split parts are excluded,
 * like the spending reports. Returns null when the merchant has no
 * categorised history — the user then picks a category by hand.
 */
export async function suggestCategoryForMerchant(
  exec: Executor,
  actor: Actor,
  merchant: string
): Promise<SmsCategorySuggestion | null> {
  const name = merchant.trim();
  if (!name) return null;
  const rows = await exec
    .select({
      categoryId: transactions.categoryId,
      name: categories.name,
      useCount: sql<number>`CAST(count(*) AS INTEGER)`,
      lastUsed: max(entries.date)
    })
    .from(transactions)
    .innerJoin(entries, eq(transactions.entryId, entries.id))
    .innerJoin(accounts, eq(entries.accountId, accounts.id))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(accounts.familyId, actor.familyId),
        sql`lower(${transactions.merchant}) = lower(${name})`,
        isNotNull(transactions.categoryId),
        ne(transactions.merchant, ""),
        sql`${transactions.transferId} IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = ${entries.id})`,
        sql`(
          accounts.owner_id IS NULL
          OR accounts.owner_id = ${actor.userId}
          OR EXISTS (
            SELECT 1 FROM account_shares s
            WHERE s.account_id = accounts.id AND s.user_id = ${actor.userId}
          )
        )`
      )
    )
    .groupBy(transactions.categoryId, categories.name)
    .orderBy(desc(sql`count(*)`), desc(max(entries.date)))
    .limit(1);
  const row = rows[0];
  if (!row?.categoryId || !row.name) return null;
  return { id: row.categoryId, name: row.name, useCount: row.useCount };
}

export async function previewSmsImport(
  exec: Executor,
  actor: Actor,
  family: Family,
  rawSms: string,
  sender?: string | null
): Promise<SmsImportPreview> {
  const text = rawSms.trim();
  if (!text) throw errors.validation("Paste the SMS text first.");
  if (text.length > 4000) throw errors.validation("SMS text is too long.");
  const parsed: ParsedSmsResult = parseSms(text, sender || null);
  if (parsed.amountMinor <= 0) {
    throw errors.validation("Could not find an amount in this SMS. Check the text and try again.");
  }

  const match = await matchAccountForSms(
    exec,
    actor.familyId,
    {
      bankName: parsed.bankName,
      accountDigits: parsed.accountDigits,
      accountNumber: parsed.accountNumber,
      sender: sender || null,
      rawText: text
    },
    actor
  );

  const suggestedCategory = parsed.merchant
    ? await suggestCategoryForMerchant(exec, actor, parsed.merchant)
    : null;

  let duplicateEntryId: string | null = null;
  if (match && parsed.referenceId) {
    duplicateEntryId = await findEntryByExternalId(exec, {
      accountId: match.account.id,
      externalSource: SMS_EXTERNAL_SOURCE,
      externalId: parsed.referenceId
    });
  }

  return {
    parsed: {
      amountMinor: parsed.amountMinor,
      amountMajor: parsed.amountMajor,
      currency: parsed.currency,
      kind: parsed.kind,
      date: parsed.date,
      dateExplicit: parsed.dateExplicit,
      accountDigits: parsed.accountDigits,
      bankName: parsed.bankName,
      remarks: parsed.remarks,
      merchant: parsed.merchant,
      referenceId: parsed.referenceId
    },
    account: match
      ? {
          id: match.account.id,
          name: match.account.name,
          institution: match.account.institution,
          currency: match.account.currency,
          matchedBy: match.matchedBy
        }
      : null,
    suggestedCategory,
    duplicateEntryId,
    currencyMismatch: Boolean(match && parsed.currency !== match.account.currency)
  };
}

export type ConfirmSmsImportInput = {
  rawSms: string;
  sender?: string | null;
  accountId: string;
  categoryId?: string | null;
  /** Display name; defaults to the SMS remarks. */
  name?: string | null;
  /** YYYY-MM-DD; defaults to the SMS date, else today in the family timezone. */
  date?: string | null;
  /** Decimal amount in the ACCOUNT's currency; defaults to the SMS amount. */
  amountText?: string | null;
  merchant?: string | null;
};

/**
 * Records a parsed SMS as a transaction (one-tap confirm). The SMS is
 * re-parsed here from the raw text — the preview is display-only, never
 * trusted for the amount or date. The amount is always interpreted in
 * the account's currency; when the SMS currency differs, the preview
 * warns and the user confirms the amount in the account currency.
 * Dedupe is enforced by the entry layer on (account, source, reference
 * id): a second confirm returns { duplicated: true } with the original
 * entry id and creates nothing.
 */
export async function confirmSmsImport(
  exec: Executor,
  actor: Actor,
  family: Family,
  input: ConfirmSmsImportInput
): Promise<{ entryId: string; duplicated: boolean }> {
  const text = input.rawSms.trim();
  if (!text) throw errors.validation("Paste the SMS text first.");
  const parsed = parseSms(text, input.sender || null);
  if (parsed.amountMinor <= 0) {
    throw errors.validation("Could not find an amount in this SMS.");
  }

  const [account] = await exec
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.familyId, actor.familyId)))
    .limit(1);
  if (!account) throw errors.validation("Unknown account.");
  if (account.status !== "active") throw errors.validation("Account is closed.");

  const amountText = input.amountText?.trim() || String(parsed.amountMajor);
  const amountMinor = parseAmountToMinor(amountText, account.currency);
  if (amountMinor <= 0) throw errors.validation("Amount must be greater than zero.");

  let date: string;
  const explicitDate = input.date?.trim() || null;
  if (explicitDate !== null) {
    if (!isIsoDate(explicitDate)) {
      throw errors.validation("Date must be a valid calendar date in YYYY-MM-DD format.");
    }
    date = explicitDate;
  } else if (parsed.dateExplicit && isIsoDate(parsed.date)) {
    date = parsed.date;
  } else {
    date = todayIn(family.timezone);
  }

  const name =
    input.name?.trim() ||
    parsed.remarks?.slice(0, MAX_NAME_LENGTH) ||
    `${parsed.bankName ?? account.name} ${parsed.kind === "expense" ? "Payment" : "Deposit"}`;

  const amountLedgerMinor =
    parsed.kind === "expense" ? Math.abs(amountMinor) : -Math.abs(amountMinor);

  return addTransaction(exec, actor, {
    accountId: account.id,
    date,
    amountLedgerMinor,
    name,
    categoryId: input.categoryId || null,
    merchant: input.merchant?.trim() || parsed.merchant || null,
    notes: `[SMS Alert]\n${text}`,
    externalSource: SMS_EXTERNAL_SOURCE,
    externalId: parsed.referenceId
  });
}
