"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, withTransaction } from "@/server/db/client";
import { assertActor } from "@/server/auth/context";
import { parseAmountToMinor } from "@/lib/money";
import { errors } from "@/lib/errors";
import { runAction, formValues, type ActionState } from "@/server/actions/runner";
import * as accountsSvc from "@/server/domain/accounts";
import * as balanceTrackingSvc from "@/server/domain/balance-tracking";
import { recalculateAccount } from "@/server/domain/balances";

const createSchema = z.object({
  type: z.enum(["depository", "credit_card", "other_asset", "other_liability"]),
  name: z.string().min(1).max(120),
  currency: z.string().length(3),
  subtype: z.string().optional(),
  institution: z.string().optional(),
  openingBalance: z.string().optional(),
  openedOn: z.string().min(8),
  includedInReports: z.string().optional(),
  joint: z.string().optional(),
  balanceTracking: z.enum(["valuation", "transactions"]).optional()
});

export async function createAccountAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = createSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("account.create", async () => {
    const actor = await assertActor();
    let accountId = "";
    await withTransaction(async (tx) => {
      const res = await accountsSvc.createAccount(tx, actor, {
        type: input.type,
        name: input.name,
        currency: input.currency,
        subtype: input.subtype ?? null,
        institution: input.institution ?? null,
        openingBalanceDisplayMinor: input.openingBalance
          ? parseAmountToMinor(input.openingBalance, input.currency)
          : 0,
        openedOn: input.openedOn,
        includedInReports: input.includedInReports === "on",
        joint: input.joint === "on",
        balanceTracking: input.balanceTracking
      });
      accountId = res.accountId;
      await recalculateAccount(tx, accountId);
    });
    revalidatePath("/accounts");
    revalidatePath("/");
    redirect(`/accounts/${accountId}`);
  });
}

const updateSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  institution: z.string().optional(),
  subtype: z.string().optional(),
  includedInReports: z.enum(["on", "off"]).optional()
});

export async function updateAccountAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = updateSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("account.update", async () => {
    const actor = await assertActor();
    await withTransaction((tx) =>
      accountsSvc.updateAccount(tx, actor, input.accountId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.institution !== undefined ? { institution: input.institution } : {}),
        ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
        ...(input.includedInReports !== undefined
          ? { includedInReports: input.includedInReports === "on" }
          : {})
      })
    );
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${input.accountId}`);
    return undefined;
  });
}

const statusSchema = z.object({
  accountId: z.string().uuid(),
  status: z.enum(["active", "draft", "disabled"])
});

export async function setAccountStatusAction(formData: FormData): Promise<void> {
  const parsed = statusSchema.safeParse(formValues(formData));
  if (!parsed.success) return;
  await runAction("account.status", async () => {
    const actor = await assertActor();
    await withTransaction((tx) =>
      accountsSvc.setAccountStatus(tx, actor, parsed.data!.accountId, parsed.data!.status)
    );
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${parsed.data!.accountId}`);
    revalidatePath("/");
  });
}

const deleteSchema = z.object({
  accountId: z.string().uuid(),
  confirmName: z.string().min(1)
});

export async function deleteAccountAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("account.delete", async () => {
    const input = deleteSchema.parse(formValues(formData));
    const actor = await assertActor();
    const res = await getDb().execute<{ name: string }>(
      sql`SELECT name FROM accounts WHERE id = ${input.accountId}`
    );
    const row = (res.rows ?? [])[0];
    if (!row) throw errors.notFound("Account");
    if (row.name !== input.confirmName) {
      throw errors.validation("The confirmation text does not match the account name.");
    }
    await withTransaction((tx) => accountsSvc.deleteAccount(tx, actor, input.accountId));
    revalidatePath("/accounts");
    revalidatePath("/");
    redirect("/accounts");
  });
}

const shareSchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().uuid(),
  permission: z.enum(["full_control", "read_write", "read_only"]),
  op: z.enum(["share", "unshare"])
});

export async function shareAccountAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("account.share", async () => {
    const input = shareSchema.parse(formValues(formData));
    const actor = await assertActor();
    await withTransaction((tx) =>
      input.op === "share"
        ? accountsSvc.shareAccount(tx, actor, input.accountId, input.userId, input.permission)
        : accountsSvc.unshareAccount(tx, actor, input.accountId, input.userId)
    );
    revalidatePath(`/accounts/${input.accountId}`);
    return undefined;
  });
}

const switchTrackingSchema = z.object({
  accountId: z.string().uuid(),
  to: z.enum(["valuation", "transactions"])
});

export async function switchBalanceTrackingAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = switchTrackingSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("account.balance_tracking", async () => {
    const actor = await assertActor();
    await withTransaction((tx) =>
      balanceTrackingSvc.switchBalanceTracking(tx, actor, {
        accountId: input.accountId,
        to: input.to
      })
    );
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${input.accountId}`);
    revalidatePath("/");
    return undefined;
  });
}
