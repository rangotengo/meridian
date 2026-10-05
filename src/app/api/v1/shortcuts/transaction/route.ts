import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authenticateApiRequest } from "@/server/auth/api-auth";
import { getDb, withTransaction } from "@/server/db/client";
import { parseSms } from "@/server/domain/sms-parser";
import { matchAccountForSms } from "@/server/domain/account-matcher";
import { addTransaction } from "@/server/domain/orchestrate";
import { MAX_NAME_LENGTH } from "@/server/domain/entries";
import { getFamilyById } from "@/server/domain/families";
import { categories } from "@/server/db/schema";
import { parseAmountToMinor, minorToMajor } from "@/lib/money";
import { isIsoDate, todayIn } from "@/lib/datetime";
import { DomainError } from "@/lib/errors";
import { apiErrorResponse, guardMutatingRequest, readJsonBody } from "../http";

const bodySchema = z.object({
  // SMS text aliases accepted from Shortcuts/Tasker
  rawSms: z.string().max(4000).optional(),
  sms: z.string().max(4000).optional(),
  message: z.string().max(4000).optional(),
  body: z.string().max(4000).optional(),
  sender: z.string().max(100).optional(),
  from: z.string().max(100).optional(),
  // Description aliases
  name: z.string().max(MAX_NAME_LENGTH).optional(),
  note: z.string().max(MAX_NAME_LENGTH).optional(),
  description: z.string().max(MAX_NAME_LENGTH).optional(),
  amount: z.union([z.number(), z.string().max(64)]).optional(),
  kind: z.string().max(20).optional(),
  type: z.string().max(20).optional(),
  accountId: z.string().uuid().optional(),
  bank: z.string().max(120).optional(),
  date: z.string().max(10).optional(),
  categoryId: z.string().uuid().optional(),
  category: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  externalId: z.string().max(200).optional()
});

const INCOME_KINDS = ["income", "credit", "cr", "deposit"];
const EXPENSE_KINDS = ["expense", "debit", "dr", "withdrawal"];

function badRequest(message: string): DomainError {
  return new DomainError("validation.failed", message, { status: 400 });
}

export async function POST(req: Request) {
  try {
    const guard = guardMutatingRequest(req);
    if (guard) return guard;

    const actor = await authenticateApiRequest(req);
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) return bodyResult.res;

    const parsedBody = bodySchema.safeParse(bodyResult.data);
    if (!parsedBody.success) {
      return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
    }
    const body = parsedBody.data;

    const rawSms = (body.rawSms ?? body.sms ?? body.message ?? body.body ?? "").trim();
    const sender = (body.sender ?? body.from ?? "").trim();
    const userPromptNote = (body.name ?? body.note ?? body.description ?? "").trim();

    // 1. Parse SMS if provided
    const parsedSms = rawSms ? parseSms(rawSms, sender || null) : null;

    // 2. Resolve Kind (expense vs income)
    let kind: "expense" | "income" = "expense";
    const explicitKind = (body.kind ?? body.type ?? "").toLowerCase();
    if (INCOME_KINDS.includes(explicitKind)) {
      kind = "income";
    } else if (EXPENSE_KINDS.includes(explicitKind)) {
      kind = "expense";
    } else if (parsedSms) {
      kind = parsedSms.kind;
    }

    // 3. Resolve Account & Match (only accounts this actor can write to)
    const db = getDb();
    const matchResult = await matchAccountForSms(
      db,
      actor.familyId,
      {
        preferredAccountId: body.accountId ?? null,
        bankName: body.bank || parsedSms?.bankName || null,
        accountDigits: parsedSms?.accountDigits || null,
        accountNumber: parsedSms?.accountNumber || null,
        sender: sender || null,
        rawText: rawSms || null
      },
      actor
    );

    if (!matchResult) {
      throw badRequest(
        "No eligible accounts found for this API key. Create an account (or share one with write access) first."
      );
    }

    const { account, matchedBy } = matchResult;

    // 4. Resolve Amount — currency-aware minor units, float math avoided.
    //    Rejects non-finite, negative, zero, over-precise, and unsafe amounts.
    let amountMinor = 0;
    const hasExplicitAmount =
      body.amount !== undefined && body.amount !== null && body.amount !== "";

    if (hasExplicitAmount) {
      if (typeof body.amount === "number" && !Number.isFinite(body.amount)) {
        throw badRequest("Amount must be a finite number.");
      }
      // parseAmountToMinor throws a 422 DomainError for malformed input,
      // precision beyond the account currency's exponent, or unsafe magnitude.
      const minor = parseAmountToMinor(String(body.amount), account.currency);
      if (minor <= 0) {
        throw badRequest("Amount must be greater than zero.");
      }
      amountMinor = minor;
    } else if (parsedSms && parsedSms.amountMinor > 0) {
      amountMinor = parsedSms.amountMinor;
    }

    if (amountMinor <= 0) {
      throw badRequest(
        "Could not determine transaction amount. Please provide an amount or SMS text."
      );
    }

    // 5. Resolve Date — explicit dates must be valid YYYY-MM-DD; when absent
    //    default to today in the family's timezone (not the server's UTC date).
    let date: string;
    const explicitDate =
      body.date !== undefined && body.date !== null && body.date !== "" ? body.date.trim() : null;
    if (explicitDate !== null) {
      if (!isIsoDate(explicitDate)) {
        throw badRequest("Date must be a valid calendar date in YYYY-MM-DD format.");
      }
      date = explicitDate;
    } else if (parsedSms?.dateExplicit && isIsoDate(parsedSms.date)) {
      date = parsedSms.date;
    } else {
      const family = await getFamilyById(db, actor.familyId);
      date = todayIn(family?.timezone ?? "Etc/UTC");
    }

    // 6. Resolve Category
    let categoryId: string | null = null;
    let categoryName: string | null = null;

    if (body.categoryId) {
      const [cat] = await db
        .select()
        .from(categories)
        .where(and(eq(categories.id, body.categoryId), eq(categories.familyId, actor.familyId)))
        .limit(1);
      if (cat) {
        categoryId = cat.id;
        categoryName = cat.name;
      }
    } else if (body.category) {
      const catInput = body.category.trim().toLowerCase();
      const allCats = await db
        .select()
        .from(categories)
        .where(eq(categories.familyId, actor.familyId));
      const found = allCats.find((c) => c.name.toLowerCase() === catInput);
      if (found) {
        categoryId = found.id;
        categoryName = found.name;
      }
    }

    // 7. Resolve Description / Name — user prompt input takes precedence,
    //    then SMS remarks / bank name, then a generic fallback.
    let name = userPromptNote;
    if (!name) {
      if (parsedSms?.remarks) {
        name = parsedSms.remarks.slice(0, MAX_NAME_LENGTH);
      } else if (parsedSms?.bankName) {
        name = `${parsedSms.bankName} ${kind === "expense" ? "Payment" : "Deposit"}`;
      } else {
        name = `${account.name} ${kind === "expense" ? "Expense" : "Income"}`;
      }
    }

    // 8. Notes & Paper Trail
    const noteParts: string[] = [];
    if (body.notes) noteParts.push(body.notes.trim());
    if (rawSms) noteParts.push(`[SMS Alert]\n${rawSms}`);
    const notes = noteParts.length > 0 ? noteParts.join("\n\n") : null;

    // 9. Sign convention: Meridian uses POSITIVE for expenses, NEGATIVE for income
    const amountLedgerMinor = kind === "expense" ? Math.abs(amountMinor) : -Math.abs(amountMinor);

    // 10. Deduplication key
    const externalId = body.externalId || parsedSms?.referenceId || null;

    // 11. Create the Transaction — validation/DomainErrors propagate to the
    //     shared error mapper with their proper status codes.
    const result = await withTransaction(async (tx) => {
      return addTransaction(tx, actor, {
        accountId: account.id,
        date,
        amountLedgerMinor,
        name,
        categoryId,
        merchant: parsedSms?.merchant || null,
        notes,
        externalSource: "sms_shortcut",
        externalId
      });
    });

    return NextResponse.json({
      ok: true,
      duplicated: result.duplicated,
      message: result.duplicated
        ? "Transaction already recorded (duplicate detected)."
        : "Transaction successfully recorded.",
      entry: {
        id: result.entryId,
        name,
        amount: minorToMajor(amountMinor, account.currency),
        currency: account.currency,
        kind,
        date,
        account: {
          id: account.id,
          name: account.name,
          institution: account.institution,
          matchedBy
        },
        category: categoryName
      }
    });
  } catch (err: unknown) {
    return apiErrorResponse(err, "shortcuts.transaction");
  }
}
