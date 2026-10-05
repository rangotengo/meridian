import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams } from "../db/params";
import {
  accounts,
  entries,
  meroShareAccounts,
  meroShareConnections,
  meroShareHoldings,
  meroShareTransactions,
  valuations
} from "../db/schema";
import type { Actor } from "../auth/context";
import { recordAudit } from "../observability/audit";
import { recalculateAccount } from "./balances";
import { decryptProviderSecret, encryptProviderSecret } from "../security/secrets";
import { errors } from "@/lib/errors";
import { isIsoDate, todayIn } from "@/lib/datetime";
import { currencyExponent } from "@/lib/money";
import fallbackCapitals from "./meroshare-capitals-cache.json";

const BASE_URL = "https://webbackend.cdsc.com.np";
const CAPITALS_PATH = "/api/meroShare/capital/";
const AUTH_PATH = "/api/meroShare/auth/";
const OWN_DETAIL_PATH = "/api/meroShare/ownDetail/";
const PORTFOLIO_PATH = "/api/meroShareView/myPortfolio/";
const TRANSACTIONS_PATH = "/api/meroShareView/myTransaction/";
const WACC_PATH = "/api/myPurchase/waccReport/";

const PAGE_SIZE = 200;
const MAX_ACCOUNTS = 20;
const MAX_HOLDINGS = 1_000;
const MAX_TRANSACTIONS = 10_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type MeroShareCapital = { id: number; code: string; name: string };
export type MeroShareCredentials = { clientId: number; username: string; password: string };

export type MeroShareHolding = {
  ticker: string;
  name: string;
  quantity: string;
  marketPrice: string;
  marketValue: string;
  costBasis: string | null;
};

export type MeroShareTransaction = {
  externalId: string;
  ticker: string;
  name: string;
  quantity: string;
  price: string | null;
  estimatedValue: string | null;
  activityLabel: "Buy" | "Sell" | "Other";
  occurredOn: string;
  description: string | null;
  transactionCode: string | null;
};

export type MeroShareSnapshotAccount = {
  name: string;
  boid: string;
  totalValue: string;
  holdings: MeroShareHolding[];
  transactions: MeroShareTransaction[];
};

export type MeroShareSnapshot = {
  accounts: MeroShareSnapshotAccount[];
};

export class MeroShareClient {
  private authorization: string | null = null;

  constructor(
    private readonly credentials: MeroShareCredentials,
    private readonly fetchFn: FetchLike = fetch
  ) {}

  static async capitals(fetchFn: FetchLike = fetch): Promise<MeroShareCapital[]> {
    try {
      const client = new MeroShareClient(
        { clientId: 1, username: "unused", password: "unused" },
        fetchFn
      );
      const payload = await client.requestJson(CAPITALS_PATH, {
        authenticated: false,
        maxBytes: 1024 * 1024
      });
      if (Array.isArray(payload)) {
        const list = payload
          .flatMap((value) => {
            if (!isRecord(value)) return [];
            const id = Number(value.id);
            const code = text(value.code, 32);
            const name = text(value.name, 160);
            return Number.isInteger(id) && id > 0 && code && name ? [{ id, code, name }] : [];
          })
          .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
        if (list.length > 0) return list;
      }
    } catch (err) {
      console.warn(
        "Failed to fetch fresh MeroShare capitals list from CDSC; using fallback cache:",
        err
      );
    }
    return fallbackCapitals as MeroShareCapital[];
  }

  async portfolioSnapshot(): Promise<MeroShareSnapshot> {
    if (!Number.isInteger(this.credentials.clientId) || this.credentials.clientId <= 0) {
      throw errors.validation("Choose a valid MeroShare DP.");
    }
    if (!this.credentials.username.trim() || !this.credentials.password) {
      throw errors.validation("MeroShare username and password are required.");
    }

    await this.authenticate();
    const detail = await this.ownDetail();
    const boid = normalizeBoid(detail.demat);
    const clientCode = text(detail.clientCode, 80);
    if (!clientCode) throw errors.validation("MeroShare did not return a client code.");

    const [portfolio, rawTransactions, wacc] = await Promise.all([
      this.portfolio(boid, clientCode),
      this.transactionHistory(boid, clientCode),
      this.waccReport(boid)
    ]);

    const waccByTicker = new Map<string, Record<string, unknown>>();
    const rows =
      isRecord(wacc) && Array.isArray(wacc.waccReportResponse) ? wacc.waccReportResponse : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const ticker = normalizeTicker(row.scrip);
      if (ticker) waccByTicker.set(ticker, row);
    }

    const portfolioRows =
      isRecord(portfolio) && Array.isArray(portfolio.meroShareMyPortfolio)
        ? portfolio.meroShareMyPortfolio
        : null;
    if (!portfolioRows) throw errors.validation("MeroShare did not return portfolio holdings.");

    const holdings: MeroShareHolding[] = [];
    for (const row of portfolioRows) {
      if (!isRecord(row)) continue;
      const ticker = normalizeTicker(row.script);
      const name = firstText(row.scriptDesc, row.companyName, ticker) ?? "Unknown holding";
      if (!ticker) continue;
      const quantity = decimal(row.currentBalance, `holding quantity for ${ticker}`, {
        nonNegative: true
      });
      const marketPrice = decimal(
        row.lastTransactionPrice ?? row.previousClosingPrice,
        `price for ${ticker}`,
        { nonNegative: true }
      );
      const rawValue =
        row.valueOfLastTransPrice ??
        row.valueAsOfLastTransactionPrice ??
        row.valueOfPrevClosingPrice ??
        row.valueAsOfPreviousClosingPrice ??
        row.valueAsOf;
      const marketValue =
        rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== ""
          ? decimal(rawValue, `market value for ${ticker}`, { nonNegative: true })
          : multiplyDecimal(quantity, marketPrice);
      const waccRow = waccByTicker.get(ticker);
      const costBasis =
        waccRow && isRecord(waccRow)
          ? optionalDecimal(waccRow.rate, `cost basis for ${ticker}`)
          : null;
      holdings.push({ ticker, name, quantity, marketPrice, marketValue, costBasis });
      if (holdings.length > MAX_HOLDINGS) {
        throw errors.validation(
          "MeroShare returned more holdings than Meridian can safely import."
        );
      }
    }

    const transactionRows =
      isRecord(rawTransactions) && Array.isArray(rawTransactions.myTransactionHistory)
        ? rawTransactions.myTransactionHistory
        : [];
    const transactions: MeroShareTransaction[] = [];
    for (const row of transactionRows) {
      if (!isRecord(row)) continue;
      const ticker = normalizeTicker(row.scrip);
      if (!ticker) continue;
      const name = firstText(row.scripName, row.companyName, ticker) ?? ticker;
      const occurredOn = isIsoDate(String(row.historyDate ?? "").slice(0, 10))
        ? String(row.historyDate).slice(0, 10)
        : null;
      if (!occurredOn) continue;
      const quantity = decimal(row.quantity, `transaction quantity for ${ticker}`, {
        nonNegative: true
      });
      const price = optionalDecimal(row.rate, `rate for ${ticker}`);
      const estimatedValue =
        price !== null
          ? multiplyDecimal(quantity, price)
          : optionalDecimal(row.amount, `amount for ${ticker}`);
      const rawActivity = String(row.activityLabel ?? "")
        .trim()
        .toLowerCase();
      const activityLabel: MeroShareTransaction["activityLabel"] = rawActivity.includes("buy")
        ? "Buy"
        : rawActivity.includes("sell")
          ? "Sell"
          : "Other";
      const description = text(row.remarks, 255);
      const transactionCode = text(row.transactionCode, 64);
      const hash = createHash("sha256")
        .update(
          `${boid}:${ticker}:${occurredOn}:${quantity}:${activityLabel}:${transactionCode ?? ""}:${description ?? ""}`
        )
        .digest("hex")
        .slice(0, 32);
      transactions.push({
        externalId: hash,
        ticker,
        name,
        quantity,
        price,
        estimatedValue,
        activityLabel,
        occurredOn,
        description,
        transactionCode
      });
      if (transactions.length > MAX_TRANSACTIONS) {
        throw errors.validation(
          "MeroShare returned more transactions than Meridian can safely import."
        );
      }
    }

    const accountName = firstText(detail.name, `BOID ${boid}`) ?? `MeroShare ${boid.slice(-4)}`;
    const totalValue =
      optionalDecimal(
        portfolio.totalValueOfLastTransPrice ??
          portfolio.totalValueAsOfLastTransactionPrice ??
          portfolio.totalValueOfPrevClosingPrice ??
          portfolio.totalValueAsOfPreviousClosingPrice ??
          portfolio.totalValueAsOf,
        "portfolio total"
      ) ?? sumDecimalStrings(holdings.map((h) => h.marketValue));

    return {
      accounts: [
        {
          name: accountName,
          boid,
          totalValue,
          holdings,
          transactions
        }
      ]
    };
  }

  private async authenticate(): Promise<void> {
    const response = await this.request(AUTH_PATH, {
      method: "POST",
      authenticated: false,
      authenticationRequest: true,
      body: {
        clientId: this.credentials.clientId,
        username: this.credentials.username,
        password: this.credentials.password
      },
      maxBytes: 1024 * 64
    });
    const authHeader = response.headers.get("Authorization");
    if (!authHeader) throw errors.validation("MeroShare did not return an authorization token.");
    this.authorization = authHeader;
  }

  private async ownDetail(): Promise<Record<string, unknown>> {
    const payload = await this.requestJson(OWN_DETAIL_PATH, {
      authenticated: true,
      maxBytes: 1024 * 128
    });
    if (!isRecord(payload)) throw errors.validation("MeroShare did not return user details.");
    return payload;
  }

  private async portfolio(boid: string, clientCode: string): Promise<Record<string, unknown>> {
    const payload = await this.requestJson(PORTFOLIO_PATH, {
      method: "POST",
      authenticated: true,
      body: {
        demat: [boid],
        clientCode,
        page: 1,
        size: PAGE_SIZE,
        sortAsc: true,
        sortBy: "script"
      },
      maxBytes: MAX_RESPONSE_BYTES
    });
    if (!isRecord(payload)) throw errors.validation("MeroShare did not return portfolio data.");
    return payload;
  }

  private async transactionHistory(
    boid: string,
    clientCode: string
  ): Promise<Record<string, unknown>> {
    const payload = await this.requestJson(TRANSACTIONS_PATH, {
      method: "POST",
      authenticated: true,
      body: {
        demat: [boid],
        clientCode,
        page: 1,
        size: PAGE_SIZE,
        sortAsc: false,
        sortBy: "historyDate"
      },
      maxBytes: MAX_RESPONSE_BYTES
    });
    if (!isRecord(payload)) throw errors.validation("MeroShare did not return transactions data.");
    return payload;
  }

  private async waccReport(boid: string): Promise<Record<string, unknown>> {
    const payload = await this.requestJson(WACC_PATH, {
      method: "POST",
      authenticated: true,
      body: { demat: boid },
      maxBytes: MAX_RESPONSE_BYTES
    });
    if (!isRecord(payload)) throw errors.validation("MeroShare did not return purchase cost data.");
    return payload;
  }

  private async requestJson(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      authenticated?: boolean;
      maxBytes: number;
    }
  ): Promise<unknown> {
    const response = await this.request(path, options);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw errors.validation("MeroShare returned an unreadable response.");
    }
  }

  private async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      authenticated?: boolean;
      maxBytes: number;
      authenticationRequest?: boolean;
    }
  ): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://meroshare.cdsc.com.np",
      Referer: "https://meroshare.cdsc.com.np/",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"'
    });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.authenticated !== false && this.authorization)
      headers.set("Authorization", this.authorization);
    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, BASE_URL), {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
      });
    } catch (err) {
      console.warn("MeroShare fetch error:", err);
      throw errors.validation("MeroShare could not be reached. Try again shortly.");
    }
    if (options.authenticationRequest && [400, 401, 403].includes(response.status)) {
      throw errors.validation("MeroShare rejected the supplied credentials.");
    }
    if ([401, 403].includes(response.status))
      throw errors.validation("The MeroShare session was rejected. Reconnect the account.");
    if (response.status === 429 || response.status >= 500)
      throw errors.validation("MeroShare is temporarily unavailable. Try again later.");
    if (!response.ok) throw errors.validation("MeroShare could not complete that request.");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > options.maxBytes)
      throw errors.validation("MeroShare returned more data than Meridian can safely import.");

    // Stream the body with a hard byte cap so a chunked response without
    // content-length cannot be buffered whole before the size check runs.
    const reader = response.body?.getReader();
    let payload: Uint8Array<ArrayBuffer> | ArrayBuffer;
    if (!reader) {
      payload = await response.arrayBuffer();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > options.maxBytes)
          throw errors.validation("MeroShare returned more data than Meridian can safely import.");
        chunks.push(value);
      }
      payload = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    if (payload.byteLength > options.maxBytes)
      throw errors.validation("MeroShare returned more data than Meridian can safely import.");
    return new Response(payload, { status: response.status, headers: response.headers });
  }
}

export async function connectMeroShare(
  exec: Executor,
  actor: Actor,
  input: MeroShareCredentials & { capital: MeroShareCapital }
): Promise<{ connectionId: string; accounts: number }> {
  const capital = input.capital;
  if (capital.id !== input.clientId || !capital.code || !capital.name)
    throw errors.validation("Choose a valid MeroShare DP.");
  const snapshot = await new MeroShareClient(input).portfolioSnapshot();
  const connectionId = await exec.transaction(async (tx) => {
    const [connection] = await tx
      .insert(meroShareConnections)
      .values({
        familyId: actor.familyId,
        userId: actor.userId,
        name: `MeroShare · ${capital.code}`.slice(0, 100),
        clientId: input.clientId,
        dpCode: capital.code.slice(0, 32),
        dpName: capital.name.slice(0, 160),
        usernameEncrypted: encryptProviderSecret(input.username.trim()),
        passwordEncrypted: encryptProviderSecret(input.password)
      })
      .returning({ id: meroShareConnections.id });
    if (!connection) throw errors.conflict("Could not save the MeroShare connection.");
    await applySnapshot(tx, actor, connection.id, snapshot);
    return connection.id;
  });
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "meroshare.connected",
    entityType: "mero_share_connection",
    entityId: connectionId,
    metadata: { accounts: snapshot.accounts.length, dpCode: capital.code }
  });
  return { connectionId, accounts: snapshot.accounts.length };
}

export async function syncMeroShareConnection(
  exec: Executor,
  actor: Actor,
  connectionId: string
): Promise<{ accounts: number }> {
  const [connection] = await exec
    .select()
    .from(meroShareConnections)
    .where(
      and(
        eq(meroShareConnections.id, connectionId),
        eq(meroShareConnections.familyId, actor.familyId),
        eq(meroShareConnections.userId, actor.userId)
      )
    )
    .limit(1);
  if (!connection) throw errors.notFound("MeroShare connection");
  const snapshot = await new MeroShareClient({
    clientId: connection.clientId,
    username: decryptProviderSecret(connection.usernameEncrypted),
    password: decryptProviderSecret(connection.passwordEncrypted)
  }).portfolioSnapshot();
  await exec.transaction(async (tx) => {
    await applySnapshot(tx, actor, connection.id, snapshot);
  });
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "meroshare.synced",
    entityType: "mero_share_connection",
    entityId: connection.id,
    metadata: { accounts: snapshot.accounts.length }
  });
  return { accounts: snapshot.accounts.length };
}

export async function disconnectMeroShareConnection(
  exec: Executor,
  actor: Actor,
  connectionId: string
): Promise<void> {
  const [connection] = await exec
    .select({ id: meroShareConnections.id })
    .from(meroShareConnections)
    .where(
      and(
        eq(meroShareConnections.id, connectionId),
        eq(meroShareConnections.familyId, actor.familyId),
        eq(meroShareConnections.userId, actor.userId)
      )
    )
    .limit(1);
  if (!connection) throw errors.notFound("MeroShare connection");
  await exec.delete(meroShareConnections).where(eq(meroShareConnections.id, connection.id));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "meroshare.disconnected",
    entityType: "mero_share_connection",
    entityId: connection.id
  });
}

export async function listMeroShareConnections(exec: Executor, actor: Actor) {
  const rows = await exec
    .select({
      connection: meroShareConnections,
      meroAccount: meroShareAccounts,
      accountName: accounts.name,
      accountId: accounts.id
    })
    .from(meroShareConnections)
    .leftJoin(meroShareAccounts, eq(meroShareAccounts.connectionId, meroShareConnections.id))
    .leftJoin(accounts, eq(accounts.id, meroShareAccounts.accountId))
    .where(
      and(
        eq(meroShareConnections.familyId, actor.familyId),
        eq(meroShareConnections.userId, actor.userId)
      )
    );
  const meroAccountIds = rows.flatMap((row) => (row.meroAccount ? [row.meroAccount.id] : []));
  const holdingRows: (typeof meroShareHoldings.$inferSelect)[] = [];
  for (const chunk of chunkParams(meroAccountIds)) {
    const rows = await exec
      .select()
      .from(meroShareHoldings)
      .where(inArray(meroShareHoldings.meroShareAccountId, chunk))
      .orderBy(meroShareHoldings.ticker);
    holdingRows.push(...rows);
  }
  const holdingsByAccount = new Map<string, (typeof meroShareHoldings.$inferSelect)[]>();
  for (const holding of holdingRows) {
    const values = holdingsByAccount.get(holding.meroShareAccountId) ?? [];
    values.push(holding);
    holdingsByAccount.set(holding.meroShareAccountId, values);
  }
  const groups = new Map<
    string,
    {
      connection: {
        id: string;
        name: string;
        dpCode: string;
        dpName: string;
        lastSyncedAt: Date | null;
        createdAt: Date;
      };
      accounts: Array<{
        id: string;
        name: string;
        boid: string;
        totalValueMinor: number;
        lastSyncedAt: Date | null;
        holdings: Array<{
          ticker: string;
          name: string;
          quantity: string;
          marketValueMinor: number;
        }>;
      }>;
    }
  >();
  for (const row of rows) {
    const current = groups.get(row.connection.id) ?? {
      connection: {
        id: row.connection.id,
        name: row.connection.name,
        dpCode: row.connection.dpCode,
        dpName: row.connection.dpName,
        lastSyncedAt: row.connection.lastSyncedAt,
        createdAt: row.connection.createdAt
      },
      accounts: []
    };
    if (row.meroAccount && row.accountId && row.accountName) {
      current.accounts.push({
        id: row.accountId,
        name: row.accountName,
        boid: row.meroAccount.boid,
        totalValueMinor: row.meroAccount.totalValueMinor,
        lastSyncedAt: row.meroAccount.lastSyncedAt,
        holdings: (holdingsByAccount.get(row.meroAccount.id) ?? []).map((holding) => ({
          ticker: holding.ticker,
          name: holding.name,
          quantity: holding.quantity,
          marketValueMinor: holding.marketValueMinor
        }))
      });
    }
    groups.set(row.connection.id, current);
  }
  return [...groups.values()].sort(
    (a, b) => b.connection.createdAt.getTime() - a.connection.createdAt.getTime()
  );
}

async function applySnapshot(
  exec: Executor,
  actor: Actor,
  connectionId: string,
  snapshot: MeroShareSnapshot
): Promise<void> {
  if (snapshot.accounts.length === 0 || snapshot.accounts.length > MAX_ACCOUNTS) {
    throw errors.validation("MeroShare did not return a valid portfolio.");
  }
  const today = todayIn("Asia/Kathmandu");
  const recalculateIds: string[] = [];
  for (const snapshotAccount of snapshot.accounts) {
    const [existing] = await exec
      .select()
      .from(meroShareAccounts)
      .where(
        and(
          eq(meroShareAccounts.connectionId, connectionId),
          eq(meroShareAccounts.boid, snapshotAccount.boid)
        )
      )
      .limit(1);
    let meroAccountId: string;
    let accountId: string;
    const totalValueMinor = decimalToMinor(snapshotAccount.totalValue, "NPR", "portfolio value");
    if (existing) {
      meroAccountId = existing.id;
      accountId = existing.accountId;
      await exec
        .update(meroShareAccounts)
        .set({
          name: snapshotAccount.name,
          totalValueMinor,
          lastSyncedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(meroShareAccounts.id, existing.id));
    } else {
      const [account] = await exec
        .insert(accounts)
        .values({
          familyId: actor.familyId,
          ownerId: actor.userId,
          type: "other_asset",
          subtype: "investment",
          name: snapshotAccount.name,
          institution: "MeroShare",
          currency: "NPR",
          openingBalanceMinor: 0,
          openedOn: today,
          includedInReports: true,
          externalSource: "meroshare",
          externalId: `boid:${snapshotAccount.boid}`
        })
        .returning({ id: accounts.id });
      if (!account) throw errors.conflict("Could not create the MeroShare investment account.");
      accountId = account.id;
      const [meroAccount] = await exec
        .insert(meroShareAccounts)
        .values({
          connectionId,
          accountId,
          boid: snapshotAccount.boid,
          name: snapshotAccount.name,
          currency: "NPR",
          totalValueMinor,
          lastSyncedAt: new Date()
        })
        .returning({ id: meroShareAccounts.id });
      if (!meroAccount) throw errors.conflict("Could not create the MeroShare portfolio.");
      meroAccountId = meroAccount.id;
    }

    const valuationExternalId = `valuation:${today}`;
    const [valuationEntry] = await exec
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(
          eq(entries.accountId, accountId),
          eq(entries.externalSource, "meroshare"),
          eq(entries.externalId, valuationExternalId)
        )
      )
      .limit(1);
    if (valuationEntry) {
      await exec
        .update(entries)
        .set({ amountMinor: totalValueMinor, updatedAt: new Date() })
        .where(eq(entries.id, valuationEntry.id));
    } else {
      const [entry] = await exec
        .insert(entries)
        .values({
          accountId,
          date: today,
          amountMinor: totalValueMinor,
          currency: "NPR",
          name: "MeroShare portfolio valuation",
          externalSource: "meroshare",
          externalId: valuationExternalId,
          entryableType: "valuation"
        })
        .returning({ id: entries.id });
      if (!entry) throw errors.conflict("Could not record the MeroShare valuation.");
      await exec.insert(valuations).values({ entryId: entry.id, kind: "current" });
    }

    for (const holding of snapshotAccount.holdings) {
      await exec
        .insert(meroShareHoldings)
        .values({
          meroShareAccountId: meroAccountId,
          ticker: holding.ticker,
          name: holding.name,
          quantity: holding.quantity,
          marketPriceMinor: decimalToMinor(
            holding.marketPrice,
            "NPR",
            `price for ${holding.ticker}`
          ),
          marketValueMinor: decimalToMinor(
            holding.marketValue,
            "NPR",
            `value for ${holding.ticker}`
          ),
          costBasisMinor: holding.costBasis
            ? decimalToMinor(holding.costBasis, "NPR", `cost basis for ${holding.ticker}`)
            : null,
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: [meroShareHoldings.meroShareAccountId, meroShareHoldings.ticker],
          set: {
            name: holding.name,
            quantity: holding.quantity,
            marketPriceMinor: decimalToMinor(
              holding.marketPrice,
              "NPR",
              `price for ${holding.ticker}`
            ),
            marketValueMinor: decimalToMinor(
              holding.marketValue,
              "NPR",
              `value for ${holding.ticker}`
            ),
            costBasisMinor: holding.costBasis
              ? decimalToMinor(holding.costBasis, "NPR", `cost basis for ${holding.ticker}`)
              : null,
            updatedAt: new Date()
          }
        });
    }
    if (snapshotAccount.holdings.length === 0) {
      await exec
        .delete(meroShareHoldings)
        .where(eq(meroShareHoldings.meroShareAccountId, meroAccountId));
    } else {
      // Compute the stale set in JS and delete it in parameter-bounded
      // chunks: a NOT IN (...) list would exceed cloud SQLite's 100-param cap.
      const keep = new Set(snapshotAccount.holdings.map((holding) => holding.ticker));
      const existing = await exec
        .select({ ticker: meroShareHoldings.ticker })
        .from(meroShareHoldings)
        .where(eq(meroShareHoldings.meroShareAccountId, meroAccountId));
      const stale = existing.map((row) => row.ticker).filter((ticker) => !keep.has(ticker));
      for (const chunk of chunkParams(stale)) {
        await exec
          .delete(meroShareHoldings)
          .where(
            and(
              eq(meroShareHoldings.meroShareAccountId, meroAccountId),
              inArray(meroShareHoldings.ticker, chunk)
            )
          );
      }
    }
    for (const transaction of snapshotAccount.transactions) {
      await exec
        .insert(meroShareTransactions)
        .values({
          meroShareAccountId: meroAccountId,
          externalId: transaction.externalId,
          ticker: transaction.ticker,
          name: transaction.name,
          quantity: transaction.quantity,
          priceMinor: transaction.price
            ? decimalToMinor(transaction.price, "NPR", `price for ${transaction.ticker}`)
            : null,
          estimatedValueMinor: transaction.estimatedValue
            ? decimalToMinor(transaction.estimatedValue, "NPR", `value for ${transaction.ticker}`)
            : null,
          activityLabel: transaction.activityLabel,
          occurredOn: transaction.occurredOn,
          description: transaction.description,
          transactionCode: transaction.transactionCode,
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: [meroShareTransactions.meroShareAccountId, meroShareTransactions.externalId],
          set: {
            name: transaction.name,
            quantity: transaction.quantity,
            priceMinor: transaction.price
              ? decimalToMinor(transaction.price, "NPR", `price for ${transaction.ticker}`)
              : null,
            estimatedValueMinor: transaction.estimatedValue
              ? decimalToMinor(transaction.estimatedValue, "NPR", `value for ${transaction.ticker}`)
              : null,
            activityLabel: transaction.activityLabel,
            occurredOn: transaction.occurredOn,
            description: transaction.description,
            transactionCode: transaction.transactionCode,
            updatedAt: new Date()
          }
        });
    }
    recalculateIds.push(accountId);
  }
  await exec
    .update(meroShareConnections)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(meroShareConnections.id, connectionId));
  for (const accountId of recalculateIds) await recalculateAccount(exec, accountId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = text(value, 120);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeBoid(value: unknown): string {
  const boid = String(value ?? "").replace(/\D/g, "");
  if (!/^\d{16}$/.test(boid))
    throw errors.validation("MeroShare did not return a valid 16-digit DEMAT number.");
  return boid;
}

function normalizeTicker(value: unknown): string | null {
  const ticker = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(ticker) ? ticker : null;
}

function optionalDecimal(value: unknown, field: string): string | null {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === "" ||
    String(value).trim() === "-"
  )
    return null;
  return decimal(value, field, { nonNegative: true });
}

function decimal(value: unknown, field: string, options: { nonNegative: boolean }): string {
  const raw = String(value ?? "")
    .replace(/,/g, "")
    .trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw))
    throw errors.validation(`MeroShare returned an invalid ${field}.`);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || (options.nonNegative && numeric < 0)) {
    throw errors.validation(`MeroShare returned an invalid ${field}.`);
  }
  return raw.replace(/^\+/, "");
}

function decimalNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw errors.validation("MeroShare returned an invalid quantity.");
  return number;
}

function multiplyDecimal(a: string, b: string): string {
  const result = decimalNumber(a) * decimalNumber(b);
  if (!Number.isFinite(result)) throw errors.validation("MeroShare returned an unsupported value.");
  return String(result);
}

function sumDecimalStrings(values: string[]): string {
  const total = values.reduce((sum, value) => sum + decimalNumber(value), 0);
  if (!Number.isFinite(total))
    throw errors.validation("MeroShare returned an unsupported portfolio value.");
  return String(total);
}

function decimalToMinor(value: string, currency: string, field: string): number {
  const numeric = Number(value);
  const result = Math.round(numeric * 10 ** currencyExponent(currency));
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(result)) {
    throw errors.validation(`MeroShare returned an unsupported ${field}.`);
  }
  return result;
}
