import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateApiRequest } from "@/server/auth/api-auth";
import { getDb } from "@/server/db/client";
import { parseSms } from "@/server/domain/sms-parser";
import { matchAccountForSms } from "@/server/domain/account-matcher";
import { apiErrorResponse, guardMutatingRequest, readJsonBody } from "../http";

const bodySchema = z.object({
  rawSms: z.string().max(4000).optional(),
  sms: z.string().max(4000).optional(),
  message: z.string().max(4000).optional(),
  body: z.string().max(4000).optional(),
  sender: z.string().max(100).optional(),
  from: z.string().max(100).optional(),
  accountId: z.string().uuid().optional(),
  bank: z.string().max(120).optional()
});

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

    if (!rawSms) {
      return NextResponse.json(
        { ok: false, error: "Please provide 'rawSms' or 'sms' in the request body." },
        { status: 400 }
      );
    }

    const parsed = parseSms(rawSms, sender || null);
    const db = getDb();
    const match = await matchAccountForSms(
      db,
      actor.familyId,
      {
        preferredAccountId: body.accountId ?? null,
        bankName: body.bank || parsed.bankName || null,
        accountDigits: parsed.accountDigits,
        accountNumber: parsed.accountNumber,
        sender: sender || null,
        rawText: rawSms
      },
      actor
    );

    return NextResponse.json({
      ok: true,
      parsed: {
        amountMajor: parsed.amountMajor,
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        kind: parsed.kind,
        date: parsed.date,
        dateExplicit: parsed.dateExplicit,
        accountNumber: parsed.accountNumber,
        accountDigits: parsed.accountDigits,
        bankName: parsed.bankName,
        remarks: parsed.remarks,
        merchant: parsed.merchant,
        referenceId: parsed.referenceId
      },
      accountMatch: match
        ? {
            id: match.account.id,
            name: match.account.name,
            institution: match.account.institution,
            matchedBy: match.matchedBy
          }
        : null
    });
  } catch (err: unknown) {
    return apiErrorResponse(err, "shortcuts.parse");
  }
}
