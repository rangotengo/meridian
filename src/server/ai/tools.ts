import { z } from "zod";
import type { Executor } from "../db/client";
import type { Actor, Family } from "../auth/context";
import { currentFamily } from "../auth/context";
import { listAccountsForActor } from "../domain/accounts";
import { listCategories } from "../domain/categories";
import { createProposal, type TransactionProposalPayload } from "../domain/chat-proposals";
import { dashboardSummary, spendingByCategory, incomeExpenseSeries } from "../domain/reports";
import { parseAmountToMinor } from "@/lib/money";
import { isIsoDate, monthKeyIn } from "@/lib/datetime";
import type { ToolDefinition } from "./provider";

/** What the API route hands the client so it can render a confirm/cancel card. */
export type PendingChatProposal = {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  amountLedgerMinor: number;
  currency: string;
  date: string;
  merchant: string | null;
  categoryId: string | null;
};

export type ToolContext = {
  exec: Executor;
  actor: Actor;
  family: Family;
  proposals: PendingChatProposal[];
};

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

type Tool = { definition: ToolDefinition; schema: z.ZodTypeAny; handler: ToolHandler };

function tool(name: string, description: string, schema: z.ZodTypeAny, handler: ToolHandler): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        // zod-to-json-schema equivalent: toJSONSchema is available in zod v4
        parameters: z.toJSONSchema(schema as z.ZodType<Record<string, unknown>>)
      }
    },
    schema,
    handler
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const TOOLS: Tool[] = [
  tool(
    "list_accounts",
    "List the user's visible accounts with names, types, currencies and current balances.",
    z.object({}),
    async (_args, { exec, actor }) => {
      const accounts = await listAccountsForActor(exec, actor);
      return accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        currency: a.currency,
        status: a.status,
        balanceMinor: a.displayBalanceMinor,
        owner: a.ownerId === null ? "joint" : a.ownerId === actor.userId ? "me" : "shared"
      }));
    }
  ),
  tool(
    "list_categories",
    "List the family's spending categories.",
    z.object({}),
    async (_args, { exec, actor }) => {
      return await listCategories(exec, actor.familyId);
    }
  ),
  tool(
    "query_spending",
    "Spending totals grouped by category for a date range. Amounts are positive minor units in the family currency. Omit dates for the current month.",
    z.object({
      from: isoDate.optional().describe("Inclusive start date (YYYY-MM-DD)"),
      to: isoDate.optional().describe("Inclusive end date (YYYY-MM-DD)"),
      months: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe("Last N months including the current one; overrides from/to")
    }),
    async (args, { exec, actor, family }) => {
      let from: string | undefined = args.from as string | undefined;
      let to: string | undefined = args.to as string | undefined;
      const months = args.months as number | undefined;
      if (months) {
        const current = monthKeyIn(family.timezone);
        const start = new Date(`${current}-01T00:00:00Z`);
        start.setUTCMonth(start.getUTCMonth() - (months - 1));
        from = start.toISOString().slice(0, 10);
        to = undefined;
      }
      const range = resolveRange(family.timezone, from, to);
      const spend = await spendingByCategory(exec, family, actor.userId, range);
      return {
        range: range,
        familyCurrency: family.currency,
        byCategory: spend.categories,
        fx: spend.fx
      };
    }
  ),
  tool(
    "monthly_income_expense",
    "Income and expense totals per month for the last N months (default 6).",
    z.object({ months: z.number().int().min(1).max(36).optional() }),
    async (args, { exec, actor, family }) => {
      const months = (args.months as number | undefined) ?? 6;
      const series = await incomeExpenseSeries(exec, family, actor.userId, months);
      return {
        familyCurrency: family.currency,
        months: series.flows,
        fx: series.fx
      };
    }
  ),
  tool(
    "dashboard_summary",
    "Current net worth, assets, liabilities, and this month's income and spending.",
    z.object({}),
    async (_args, { exec, actor, family }) => {
      const s = await dashboardSummary(exec, family, actor.userId);
      return {
        familyCurrency: family.currency,
        netWorthMinor: s.netWorthMinor,
        assetsMinor: s.assetsMinor,
        liabilitiesMinor: s.liabilitiesMinor,
        incomeThisMonthMinor: s.incomeThisMonthMinor,
        expenseThisMonthMinor: s.expenseThisMonthMinor,
        monthKey: s.monthKey,
        // Same `fx` shape as query_spending / monthly_income_expense:
        // dashboardSummary exposes the fields flat (with undefined for
        // empty lists), so normalize them into an FxCompleteness object.
        fx: {
          incompleteFx: s.incompleteFx,
          fxIssues: s.fxIssues ?? [],
          fxRates: s.fxRates ?? []
        }
      };
    }
  ),
  tool(
    "create_transaction",
    "Propose recording a new transaction. Nothing is written until the user confirms the proposal in the UI. Use a NEGATIVE amount for income/received money and a POSITIVE amount for spending, consistent with the ledger's convention (positive = outflow). Dates are YYYY-MM-DD.",
    z.object({
      accountId: z.string().describe("Account id from list_accounts"),
      name: z.string().min(1).max(240),
      amount: z.number().describe("Major units, e.g. 50.25. Positive = expense, negative = income"),
      date: isoDate.optional().describe("Defaults to today"),
      categoryId: z.string().optional(),
      merchant: z.string().max(120).optional()
    }),
    async (args, ctx) => {
      const accountId = String(args.accountId ?? "");
      const name = String(args.name ?? "");
      const amount = Number(args.amount ?? 0);
      const date = args.date ? String(args.date) : monthKeyToday(ctx.family.timezone);
      if (!isIsoDate(date)) return { error: "Invalid date" };

      const account = (await listAccountsForActor(ctx.exec, ctx.actor)).find(
        (a) => a.id === accountId
      );
      if (!account) return { error: "Unknown account. Call list_accounts first." };

      const amountLedgerMinor = parseAmountToMinor(amount, account.currency);
      const payload: TransactionProposalPayload = {
        accountId,
        accountName: account.name,
        name,
        amountLedgerMinor,
        currency: account.currency,
        date,
        merchant: args.merchant ? String(args.merchant) : null,
        categoryId: args.categoryId ? String(args.categoryId) : null
      };
      const proposal = await createProposal(ctx.exec, ctx.actor, payload);
      ctx.proposals.push({ id: proposal.id, ...payload });
      return {
        proposed: true,
        proposalId: proposal.id,
        expiresInSeconds: 600,
        note: "Proposal created but NOT recorded. The user sees a confirm/cancel card. Summarize what will be recorded in one short line, make clear nothing is saved until they confirm, and do not call this tool again for the same request."
      };
    }
  )
];

function resolveRange(timezone: string, from?: string, to?: string): { from: string; to: string } {
  const today = monthKeyToday(timezone);
  if (!from) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(1);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to: to ?? today };
}

function monthKeyToday(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

const TOOL_MAP = new Map(TOOLS.map((t) => [t.definition.function.name, t]));

export function toolDefinitions(): ToolDefinition[] {
  return TOOLS.map((t) => t.definition);
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext
): Promise<unknown> {
  const t = TOOL_MAP.get(name);
  if (!t) return { error: `Unknown tool: ${name}` };
  let rawArgs: unknown;
  try {
    rawArgs = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { error: `Invalid JSON arguments for ${name}` };
  }
  const parsed = t.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: `Invalid tool arguments for ${name}: ${issue?.path.join(".") || "root"} - ${issue?.message}`
    };
  }
  try {
    return await t.handler(parsed.data as Record<string, unknown>, ctx);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function buildToolContext(exec: Executor, actor: Actor): Promise<ToolContext> {
  return { exec, actor, family: await currentFamily(actor), proposals: [] };
}
