import { eq, sql } from "drizzle-orm";
import { createCloudDatabase, type CloudStorage } from "../../src/server/db/cloud/client";
import { migrateCloudStorage } from "../../src/server/db/cloud/migrate";
import { accounts, families, users } from "../../src/server/db/cloud/schema";
import type { Executor } from "../../src/server/db/client";
import type { Actor } from "../../src/server/auth/context";
import { registerAccessHousehold } from "../../src/server/domain/access-users";
import { createAccount, getAccountOverview } from "../../src/server/domain/accounts";
import { addTransaction, makeTransferWithEntries } from "../../src/server/domain/orchestrate";
import { listEntriesPage } from "../../src/server/domain/entries";
import { dashboardSummary, incomeExpenseSeries } from "../../src/server/domain/reports";
import { upsertRate, getRate } from "../../src/server/domain/exchange-rates";
import { createSeries, postDueSeries } from "../../src/server/domain/recurring";
import { recalculateAllActiveAccounts } from "../../src/server/domain/balances-maintenance";
import { recalculateAccount } from "../../src/server/domain/balances";
import {
  recordValuation,
  updateValuation,
  deleteValuation
} from "../../src/server/domain/valuations";
import { createInvitation, acceptInvitationWithAccess } from "../../src/server/domain/invitations";
import { setBudget } from "../../src/server/domain/budgets";
import { buildFamilyExport } from "../../src/server/domain/exports";
import { importFamilyExport, parseFamilyExport } from "../../src/server/domain/family-import";
import { ensureSchedules, runDueCrons } from "../../src/server/queue/worker-loop";
import { importSureExport } from "../../src/server/domain/sure-import";
import { connectMeroShare, syncMeroShareConnection } from "../../src/server/domain/meroshare";
import {
  getSsisInsight,
  importSsisSnapshot,
  refreshSsis,
  setSsisBoAccountNo
} from "../../src/server/domain/ssis";
import { fetchSsisSnapshot } from "../../src/server/domain/ssis-fetch";
import {
  addHolding,
  adjustHolding,
  listHoldings,
  summarizeHoldings
} from "../../src/server/domain/holdings";
import { mockMeroShareFetch } from "./meroshare-fixture";
import { splitEntry } from "../../src/server/domain/splits";
import { claimBatch, completeJob, enqueue } from "../../src/server/queue";
import { createApiKey, verifyApiKey, revokeApiKey } from "../../src/server/domain/api-keys";
import {
  OAuthError,
  approveAuthorizationRequest,
  authenticateOAuthClient,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  listConnectionsForUser,
  refreshOAuthToken,
  registerOAuthClient,
  revokeGrant,
  resolveMcpAccess,
  resolveOAuthClient,
  validateAuthorizeRequest
} from "../../src/server/domain/oauth";
import type { McpConfig } from "../../src/lib/env";
import {
  createMetadataFetcher,
  type MetadataFetcher,
  type MetadataTransport
} from "../../src/server/mcp/ssrf";
import { clearCimdCaches } from "../../src/server/mcp/cimd";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { handleMcpRequest } from "../../src/server/mcp/server";
import { createHash } from "node:crypto";
import { parseSms } from "../../src/server/domain/sms-parser";
import { matchAccountForSms } from "../../src/server/domain/account-matcher";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function ddMmYy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
}

function ddMmYyyy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

export class StorageProbe {
  private db;
  private ready;
  constructor(ctx: { storage: CloudStorage }) {
    this.db = createCloudDatabase(ctx.storage);
    this.ready = migrateCloudStorage(ctx.storage);
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const db = this.db;
    const operation = new URL(request.url).pathname;
    if (
      operation === "/ledger" ||
      operation === "/import-meroshare" ||
      operation === "/valuation-edit" ||
      operation === "/ssis" ||
      operation === "/ssis-fixes" ||
      operation === "/ssis-round2" ||
      operation === "/holdings" ||
      operation === "/export-restore-precedence"
    ) {
      const exec = db as unknown as Executor;
      const user = await registerAccessHousehold(
        exec,
        { subject: "cloud-test", email: "ledger@example.test" },
        {
          name: "Ledger",
          familyName: "Cloud ledger",
          currency: "NPR",
          timezone: "UTC"
        }
      );
      const actor: Actor = {
        userId: user.id,
        familyId: user.familyId,
        email: user.email,
        name: user.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId: "",
        emailVerified: true
      };
      const today = new Date().toISOString().slice(0, 10);
      if (operation === "/valuation-edit") {
        const { accountId } = await createAccount(exec, actor, {
          name: "Valuation loan",
          type: "other_liability",
          currency: "NPR",
          openedOn: today,
          openingBalanceDisplayMinor: 10000,
          includedInReports: true,
          joint: false
        });
        const { entryId } = await recordValuation(exec, actor, {
          accountId,
          date: today,
          amountDisplayMinor: 15000,
          kind: "current"
        });
        await exec.transaction(async (tx) => {
          const result = await updateValuation(tx, actor, {
            entryId,
            date: today,
            amountDisplayMinor: 22500,
            kind: "reconciliation"
          });
          await recalculateAccount(tx, accountId, result.previousDate);
        });
        const edited = await getAccountOverview(exec, actor, accountId);
        await exec.transaction(async (tx) => {
          const result = await deleteValuation(tx, actor, entryId);
          await recalculateAccount(tx, accountId, result.date);
        });
        const deleted = await getAccountOverview(exec, actor, accountId);
        return Response.json({
          editedBalance: edited.displayBalanceMinor,
          editedKind: edited.recentActivity.find((e) => e.id === entryId)?.valuationKind,
          deletedBalance: deleted.displayBalanceMinor,
          deletedEntryAbsent: !deleted.recentActivity.some((e) => e.id === entryId)
        });
      }
      if (operation === "/holdings") {
        const { accountId } = await createAccount(exec, actor, {
          name: "Cloud brokerage",
          type: "other_asset",
          currency: "NPR",
          openedOn: today,
          openingBalanceDisplayMinor: 0,
          includedInReports: true,
          joint: false
        });
        await addHolding(exec, actor, {
          accountId,
          ticker: "NABIL",
          quantity: "100",
          averageCostMinor: null,
          currentPriceMinor: 500
        });
        // A buy into the unknown-cost position tracks only its own share
        // as known cost; two further concurrent buys serialize behind the
        // Durable Object mutex and both land.
        await adjustHolding(exec, actor, {
          accountId,
          ticker: "NABIL",
          side: "buy",
          quantity: "1",
          priceMinor: 200
        });
        await Promise.all([
          adjustHolding(exec, actor, {
            accountId,
            ticker: "NABIL",
            side: "buy",
            quantity: "1",
            priceMinor: 200
          }),
          adjustHolding(exec, actor, {
            accountId,
            ticker: "NABIL",
            side: "buy",
            quantity: "1",
            priceMinor: 200
          })
        ]);
        const rows = await listHoldings(exec, actor, accountId);
        const summary = summarizeHoldings(rows);
        let valuationRejected = false;
        try {
          await recordValuation(exec, actor, {
            accountId,
            date: today,
            amountDisplayMinor: 1,
            kind: "current"
          });
        } catch {
          valuationRejected = true;
        }
        let unpriceableRejected = false;
        try {
          await addHolding(exec, actor, {
            accountId,
            ticker: "ZZZ",
            quantity: "1",
            averageCostMinor: null,
            currentPriceMinor: null
          });
        } catch {
          unpriceableRejected = true;
        }
        const overview = await getAccountOverview(exec, actor, accountId);
        return Response.json({
          quantity: rows[0]!.quantity,
          averageCostMinor: rows[0]!.averageCostMinor,
          averageCostQuantity: rows[0]!.averageCostQuantity,
          partialCost: summary.partialCost,
          totalCostMinor: summary.totalCostMinor,
          balance: overview.displayBalanceMinor,
          valuationRejected,
          unpriceableRejected
        });
      }
      if (operation === "/export-restore-precedence") {
        // Reviewer repro 1, inside the Durable Object: a manual valuation
        // of 5000 today, then a holding worth 1000 today. The source
        // balance is 1000; the export must carry the write order, and the
        // restore into a fresh household must reproduce 1000 — on cloud
        // the tiebreak is (date, created_at, rowid), so insertion order
        // and the monotonic stamps both have to match the source.
        const { accountId } = await createAccount(exec, actor, {
          name: "Cloud precedence brokerage",
          type: "other_asset",
          currency: "NPR",
          openedOn: today,
          openingBalanceDisplayMinor: 0,
          includedInReports: true,
          joint: false
        });
        await recordValuation(exec, actor, {
          accountId,
          date: today,
          amountDisplayMinor: 5000,
          kind: "current"
        });
        await recalculateAccount(exec, accountId);
        await addHolding(exec, actor, {
          accountId,
          ticker: "NABIL",
          quantity: "10",
          averageCostMinor: null,
          currentPriceMinor: 100
        });
        const source = await getAccountOverview(exec, actor, accountId);
        const exported = await buildFamilyExport(exec, actor);
        const todaysValuations = (
          exported.entries as {
            accountId: string;
            kind: string;
            date: string;
            amountMinor: number;
            writeOrder?: number;
          }[]
        )
          .filter((e) => e.accountId === accountId && e.kind === "valuation" && e.date === today)
          .sort((a, b) => (a.writeOrder ?? 0) - (b.writeOrder ?? 0))
          .map((e) => ({ amountMinor: e.amountMinor, writeOrder: e.writeOrder ?? null }));
        const target = await registerAccessHousehold(
          exec,
          { subject: "cloud-precedence-target", email: "precedence-target@example.test" },
          {
            name: "Target",
            familyName: "Cloud precedence target",
            currency: "NPR",
            timezone: "UTC"
          }
        );
        const targetActor: Actor = {
          userId: target.id,
          familyId: target.familyId,
          email: target.email,
          name: target.name,
          familyRole: "admin",
          platformRole: "user",
          sessionId: "",
          emailVerified: true
        };
        // Model a larger history that restores faster than one millisecond
        // per entry: future-dated import stamps must not beat a fresh buy.
        const archive = JSON.parse(JSON.stringify(exported));
        const manual = archive.entries[0];
        const padding = Array.from({ length: 2000 }, (_, i) => ({
          ...manual,
          id: `prior-${i}`,
          writeOrder: i
        }));
        for (const e of archive.entries) e.writeOrder += padding.length;
        archive.entries = [...padding, ...archive.entries];
        await importFamilyExport(
          exec,
          targetActor,
          parseFamilyExport(new TextEncoder().encode(JSON.stringify(archive)))
        );
        const [restored] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.familyId, target.familyId));
        const restoredOverview = await getAccountOverview(exec, targetActor, restored!.id);
        await adjustHolding(exec, targetActor, {
          accountId: restored!.id,
          ticker: "NABIL",
          side: "buy",
          quantity: "1",
          priceMinor: 100
        });
        const afterBuy = await getAccountOverview(exec, targetActor, restored!.id);
        return Response.json({
          afterBuy: afterBuy.displayBalanceMinor,
          sourceBalance: source.displayBalanceMinor,
          restoredBalance: restoredOverview.displayBalanceMinor,
          todaysValuations
        });
      }
      if (operation === "/import-meroshare") {
        const archive = [
          {
            type: "Account",
            data: {
              id: "cash",
              name: "Imported",
              accountable_type: "Depository",
              balance: "15.00",
              currency: "NPR",
              created_at: today
            }
          },
          {
            type: "Transaction",
            data: {
              id: "coffee",
              account_id: "cash",
              name: "Coffee",
              amount: "5.00",
              currency: "NPR",
              date: today
            }
          }
        ]
          .map((record) => JSON.stringify(record))
          .join("\n");
        const imported = await importSureExport(
          exec,
          actor,
          "all.ndjson",
          new TextEncoder().encode(archive)
        );
        let repeatedImportRejected = false;
        try {
          await importSureExport(exec, actor, "all.ndjson", new TextEncoder().encode(archive));
        } catch {
          repeatedImportRejected = true;
        }
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mockMeroShareFetch;
        try {
          const connected = await connectMeroShare(exec, actor, {
            clientId: 1,
            username: "test",
            password: "test-secret",
            capital: { id: 1, code: "TEST", name: "Test DP" }
          });
          const synced = await syncMeroShareConnection(exec, actor, connected.connectionId);
          const stored = await db.execute(
            sql`SELECT username_encrypted, password_encrypted FROM mero_share_connections`
          );
          return Response.json({
            imported,
            repeatedImportRejected,
            connected: connected.accounts,
            synced: synced.accounts,
            encrypted:
              stored.rows[0]!.username_encrypted !== "test" &&
              stored.rows[0]!.password_encrypted !== "test-secret"
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
      if (operation === "/ssis") {
        const snapshot = [
          {
            unitPurchase: [
              {
                REQUEST_NO: 2001,
                FName: "Cloud",
                LName: "Holder",
                Citizenship_No: "00-00-00-00000",
                APPLY_DT: "2024-01-15",
                APPLY_UNIT: 100,
                AMOUNT: "1000.00",
                APPSTATUS: "VERIFIED",
                current_nav: 10,
                nav_date: "2024-01-15",
                SchemeName: "Siddhartha Systematic Investment Scheme",
                Is_SIP: true
              }
            ],
            statement: [
              {
                trans_no: "CT1",
                installmentDate: "2024-01-15",
                dueDate: null,
                actionDate: "2024-01-16",
                Amount_cr: "1000.00",
                Amount_dr: "-",
                unit: "100",
                appnav: "10.00",
                payment: "E-Sewa",
                otherCharges: "0",
                sebon_fee: "0",
                SIP_Reg_No: "SIP0001"
              }
            ],
            navData: {
              ResponseData: [{ Scheme_code: "001", nav_date: "2024-01-20", nav_value: 10.5 }]
            },
            overallNav: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.50" }]
          }
        ];
        const counts = await importSsisSnapshot(exec, actor, snapshot, "import");
        const insight = await getSsisInsight(exec, actor);
        return Response.json({
          counts,
          holderName: insight.holderName,
          totalUnits: insight.summary.totalUnits,
          totalInvestedMinor: insight.summary.totalInvestedMinor,
          currentNavMinor: insight.summary.currentNavMinor,
          currentValueMinor: insight.summary.currentValueMinor,
          purchases: insight.purchases.length,
          statement: insight.statement.length
        });
      }
      if (operation === "/ssis-fixes") {
        const BO1 = "1301000011112222";
        const BO2 = "1301000033334444";
        const FAULT_BO = "1301999888777666";
        // Clean slate regardless of probe order.
        await db.execute(sql`DELETE FROM ssis_purchases WHERE family_id = ${actor.familyId}`);
        await db.execute(
          sql`DELETE FROM ssis_statement_entries WHERE family_id = ${actor.familyId}`
        );
        await db.execute(sql`DELETE FROM ssis_nav_history WHERE family_id = ${actor.familyId}`);
        await db.execute(sql`DELETE FROM ssis_insight_state WHERE family_id = ${actor.familyId}`);

        const snapshotFor = (requestNo: number) => [
          {
            unitPurchase: [
              {
                REQUEST_NO: requestNo,
                FName: "Cloud",
                LName: "Holder",
                APPLY_DT: "2024-01-15",
                APPLY_UNIT: 100,
                AMOUNT: "1000.00",
                APPSTATUS: "VERIFIED",
                current_nav: 10,
                nav_date: "2024-01-15",
                SchemeName: "Siddhartha Systematic Investment Scheme",
                Is_SIP: true
              }
            ],
            statement: [],
            navData: {
              ResponseData: [{ Scheme_code: "001", nav_date: "2024-01-20", nav_value: 10.5 }]
            },
            overallNav: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.50" }]
          }
        ];
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        const validBodies = (input: unknown) => {
          const url = String(input);
          if (url.includes("PurchaseRequesthandler")) {
            return json({ ResponseData: snapshotFor(3001)[0]!.unitPurchase });
          }
          if (url.includes("HolderStatement")) return json({ ResponseData: [] });
          if (url.includes("GetNAV")) {
            return json({
              ResponseData: [{ Scheme_code: "001", nav_date: "2024-01-20", nav_value: 10.5 }]
            });
          }
          return json({ data: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.50" }] });
        };

        // Finding 1: holder binding — unconfirmed switch rejected, confirmed
        // switch clears the previous holder's datasets.
        await setSsisBoAccountNo(exec, actor, BO1);
        await importSsisSnapshot(exec, actor, snapshotFor(3001), "import");
        const switchRejected = await setSsisBoAccountNo(exec, actor, BO2).then(
          () => false,
          () => true
        );
        const switched = await setSsisBoAccountNo(exec, actor, BO2, { resetExistingData: true });
        const afterSwitch = await getSsisInsight(exec, actor);

        // Finding 1: a refresh in flight across a configuration change
        // cannot commit the old holder's rows.
        let flipped = false;
        const inflightFetch = async (input: unknown) => {
          if (!flipped) {
            flipped = true;
            await setSsisBoAccountNo(exec, actor, BO1, { resetExistingData: true });
          }
          return validBodies(input);
        };
        const inflightRejected = await refreshSsis(exec, actor, inflightFetch as typeof fetch).then(
          () => false,
          () => true
        );
        const afterInflight = await getSsisInsight(exec, actor);

        // Finding 2: an HTTP-200 application-error envelope fails every dataset.
        const appError = { IsSucess: false, ResponseData: null, success: false, data: [] };
        const allErr = await fetchSsisSnapshot(BO1, (async () => json(appError)) as typeof fetch);

        // Finding 4: individually-safe rows whose total overflows are rejected.
        const bigRow = (n: number) => ({
          REQUEST_NO: 4000 + n,
          FName: "Cloud",
          LName: "Holder",
          APPLY_DT: "2024-01-15",
          APPLY_UNIT: "10",
          AMOUNT: "90071992547409.91",
          APPSTATUS: "VERIFIED"
        });
        const oversizedRejected = await importSsisSnapshot(
          exec,
          actor,
          [
            {
              unitPurchase: [bigRow(1), bigRow(2), bigRow(3)],
              statement: [],
              navData: {},
              overallNav: []
            }
          ],
          "import"
        ).then(
          () => false,
          () => true
        );

        // Finding 3: a database fault while saving the BO number surfaces
        // only the sanitized error — never the number, in message or cause.
        let faultMessage = "";
        await db.execute(
          sql`CREATE TRIGGER ssis_fault_insert BEFORE INSERT ON ssis_insight_state BEGIN SELECT RAISE(ABORT, 'ssis fault'); END`
        );
        await db.execute(
          sql`CREATE TRIGGER ssis_fault_update BEFORE UPDATE ON ssis_insight_state BEGIN SELECT RAISE(ABORT, 'ssis fault'); END`
        );
        try {
          await setSsisBoAccountNo(exec, actor, FAULT_BO);
        } catch (e) {
          const parts: string[] = [];
          let cursor: unknown = e;
          while (cursor instanceof Error) {
            parts.push(cursor.message);
            cursor = cursor.cause;
          }
          faultMessage = parts.join("\n");
        } finally {
          await db.execute(sql`DROP TRIGGER IF EXISTS ssis_fault_insert`);
          await db.execute(sql`DROP TRIGGER IF EXISTS ssis_fault_update`);
        }

        return Response.json({
          switchRejected,
          dataReset: switched.dataReset,
          purchasesAfterSwitch: afterSwitch.purchases.length,
          holderAfterSwitch: afterSwitch.holderName,
          inflightRejected,
          purchasesAfterInflight: afterInflight.purchases.length,
          boMaskedAfterInflight: afterInflight.boAccountMasked,
          allErrorPayloadNull: allErr.payload === null,
          allErrorWarnings: allErr.warnings.length,
          oversizedRejected,
          faultMessage,
          faultChainHasBo: faultMessage.includes(FAULT_BO)
        });
      }
      if (operation === "/ssis-round2") {
        const BO1 = "1301000011112222";
        const BO2 = "1301000033334444";
        const cleanSlate = async () => {
          await db.execute(sql`DELETE FROM ssis_purchases WHERE family_id = ${actor.familyId}`);
          await db.execute(
            sql`DELETE FROM ssis_statement_entries WHERE family_id = ${actor.familyId}`
          );
          await db.execute(sql`DELETE FROM ssis_nav_history WHERE family_id = ${actor.familyId}`);
          await db.execute(sql`DELETE FROM ssis_insight_state WHERE family_id = ${actor.familyId}`);
        };
        const purchase = (overrides: Record<string, unknown>) => ({
          REQUEST_NO: 5001,
          FName: "Cloud",
          LName: "Holder",
          APPLY_DT: "2024-01-15",
          APPLY_UNIT: 100,
          AMOUNT: "1000.00",
          APPSTATUS: "VERIFIED",
          current_nav: 10,
          nav_date: "2024-01-15",
          SchemeName: "Siddhartha Systematic Investment Scheme",
          Is_SIP: true,
          ...overrides
        });
        const envelope = (parts: Record<string, unknown>) => [
          { unitPurchase: [], statement: [], navData: {}, overallNav: [], ...parts }
        ];

        // Finding A(1): the first BO set without a reset binds to
        // snapshot-imported data and keeps it.
        await cleanSlate();
        await importSsisSnapshot(exec, actor, envelope({ unitPurchase: [purchase({})] }), "import");
        const bindKept = await setSsisBoAccountNo(exec, actor, BO1);
        const afterBindKept = await getSsisInsight(exec, actor);

        // Finding A(1): the first BO set WITH an explicit reset clears the
        // imported data even though no BO was configured before.
        await cleanSlate();
        await importSsisSnapshot(exec, actor, envelope({ unitPurchase: [purchase({})] }), "import");
        const bindReset = await setSsisBoAccountNo(exec, actor, BO2, { resetExistingData: true });
        const afterBindReset = await getSsisInsight(exec, actor);

        // Finding A(2): identity asserted only by the statement dataset is
        // enforced, and an anonymous snapshot cannot merge into stored data.
        await importSsisSnapshot(exec, actor, envelope({ unitPurchase: [purchase({})] }), "import");
        const statementRow = (name: string) => ({
          trans_no: "CT9",
          installmentDate: "2024-01-15",
          dueDate: null,
          actionDate: "2024-01-16",
          Amount_cr: "100.00",
          Amount_dr: "-",
          unit: "10",
          appnav: "10.00",
          payment: "E-Sewa",
          otherCharges: "0",
          sebon_fee: "0",
          SIP_Reg_No: "SIP0001",
          Name: name
        });
        const otherHolderRejected = await importSsisSnapshot(
          exec,
          actor,
          envelope({ statement: [statementRow("Other Person")] }),
          "import"
        ).then(
          () => false,
          () => true
        );
        const anonymousRejected = await importSsisSnapshot(
          exec,
          actor,
          envelope({
            unitPurchase: [
              {
                REQUEST_NO: 5002,
                APPLY_DT: "2024-01-15",
                APPLY_UNIT: 10,
                AMOUNT: "100.00",
                APPSTATUS: "VERIFIED"
              }
            ]
          }),
          "import"
        ).then(
          () => false,
          () => true
        );
        const afterAnonymous = await getSsisInsight(exec, actor);

        // Finding B(1): two individually-safe fragments whose combined
        // invested total is unrepresentable — the second is rejected and
        // the first fragment's row remains the only one stored.
        await cleanSlate();
        const bigFragment = (requestNo: number) =>
          envelope({
            unitPurchase: [
              purchase({ REQUEST_NO: requestNo, APPLY_UNIT: "10", AMOUNT: "50000000000000.00" })
            ]
          });
        await importSsisSnapshot(exec, actor, bigFragment(6001), "import");
        const combinedRejected = await importSsisSnapshot(
          exec,
          actor,
          bigFragment(6002),
          "import"
        ).then(
          () => false,
          () => true
        );
        const afterCombined = await getSsisInsight(exec, actor);

        // Finding B(2): a NAV-only refresh that would overflow the stored
        // position is rejected; the stored NAV is untouched.
        await cleanSlate();
        await setSsisBoAccountNo(exec, actor, BO1);
        await importSsisSnapshot(
          exec,
          actor,
          envelope({
            unitPurchase: [
              purchase({ REQUEST_NO: 6003, APPLY_UNIT: "500000000000", AMOUNT: "100.00" })
            ],
            navData: {
              ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-20", nav_value: "1.00" }]
            }
          }),
          "import"
        );
        const navOnlyFetch = async (input: unknown) => {
          const url = String(input);
          const body = url.includes("GetNAV")
            ? {
                ResponseData: [
                  { Scheme_code: "001", nav_date: "2024-03-21", nav_value: "1000000.00" }
                ]
              }
            : url.includes("admin-ajax.php")
              ? { success: false, data: [] }
              : { IsSucess: false, ResponseData: null, success: false, data: [] };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        };
        const navOverflowRejected = await refreshSsis(
          exec,
          actor,
          navOnlyFetch as typeof fetch
        ).then(
          () => false,
          () => true
        );
        const afterNavOverflow = await getSsisInsight(exec, actor);

        return Response.json({
          bindKeptDataReset: bindKept.dataReset,
          purchasesAfterBindKept: afterBindKept.purchases.length,
          bindResetDataReset: bindReset.dataReset,
          purchasesAfterBindReset: afterBindReset.purchases.length,
          otherHolderRejected,
          anonymousRejected,
          purchasesAfterAnonymous: afterAnonymous.purchases.length,
          combinedRejected,
          purchasesAfterCombined: afterCombined.purchases.length,
          totalInvestedAfterCombined: afterCombined.summary.totalInvestedMinor,
          navOverflowRejected,
          navAfterNavOverflow: afterNavOverflow.summary.currentNavMinor
        });
      }
      const account = await createAccount(exec, actor, {
        name: "Cash",
        type: "depository",
        currency: "NPR",
        openedOn: today,
        openingBalanceDisplayMinor: 10000,
        includedInReports: true,
        joint: false
      });
      const second = await createAccount(exec, actor, {
        name: "Bank",
        type: "depository",
        currency: "NPR",
        openedOn: today,
        openingBalanceDisplayMinor: 0,
        includedInReports: true,
        joint: false
      });
      const input = {
        accountId: account.accountId,
        date: today,
        amountLedgerMinor: 1000,
        name: "Groceries",
        externalSource: "test",
        externalId: "unique-1"
      };
      const entry = await addTransaction(exec, actor, input);
      const duplicate = await addTransaction(exec, actor, input);
      await splitEntry(exec, actor, entry.entryId, [
        { amountLedgerMinor: 400 },
        { amountLedgerMinor: 600 }
      ]);
      await makeTransferWithEntries(exec, actor, {
        fromAccountId: account.accountId,
        toAccountId: second.accountId,
        amountDisplayMinor: 2000,
        date: today
      });
      const page = await listEntriesPage(exec, actor, { search: "groceries" });
      const [family] = await db.select().from(families).where(eq(families.id, user.familyId));
      const report = await dashboardSummary(exec, family!, user.id);
      const overview = await getAccountOverview(exec, actor, account.accountId);
      const monthly = (await incomeExpenseSeries(exec, family!, user.id, 1)).flows;
      await upsertRate(exec, { base: "USD", quote: "NPR", rate: "100", quotedOn: today });
      const inverseRate = await getRate(exec, "NPR", "USD", today);
      await setBudget(exec, actor, { categoryId: null, amountLedgerMinor: 5000 });
      await createSeries(exec, actor, {
        accountId: account.accountId,
        name: "Recurring",
        amountLedgerMinor: 100,
        frequency: "weekly",
        config: { weekday: new Date().getUTCDay() },
        nextDue: today
      });
      const recurring = await postDueSeries(exec);
      const recurringAgain = await postDueSeries(exec);
      const invitation = await createInvitation(exec, actor, {
        email: "invited@example.test",
        role: "member"
      });
      const invited = await acceptInvitationWithAccess(
        exec,
        invitation.token,
        { subject: "invited", email: "invited@example.test" },
        "Invited"
      );
      let denied = false;
      try {
        await getAccountOverview(
          exec,
          { ...actor, familyId: crypto.randomUUID(), userId: crypto.randomUUID() },
          account.accountId
        );
      } catch {
        denied = true;
      }
      const exported = await buildFamilyExport(exec, actor);
      await ensureSchedules(exec, [
        { key: "test", queue: "test-cron", cron: "*/5 * * * *", payload: { cron: true } }
      ]);
      await db.execute(sql`UPDATE cron_schedules SET next_run_at = '2020-01-01T00:00:00.000Z'`);
      const cronFired = await runDueCrons(exec);
      const cronAgain = await runDueCrons(exec);
      await enqueue(exec, "test", { valid: true });
      const jobs = await claimBatch(exec, "test-worker", 5);
      for (const job of jobs) await completeJob(exec, job.id);
      return Response.json({
        duplicate: duplicate.duplicated,
        entries: page.items.length,
        report,
        overview,
        payload: jobs.find((job) => job.queue === "test")!.payload,
        monthly,
        inverseRate,
        recurring,
        recurringAgain,
        invited,
        denied,
        exported,
        cronFired,
        cronAgain,
        cronPayload: jobs.find((job) => job.queue === "test-cron")!.payload
      });
    }
    if (operation === "/roundtrip") {
      const [family] = await db.insert(families).values({ name: "Cloud test" }).returning();
      const [user] = await db
        .insert(users)
        .values({
          familyId: family!.id,
          email: "test@example.test",
          name: "Test",
          passwordHash: "disabled",
          preferences: { privacy_mode: true }
        })
        .returning();
      const [account] = await db
        .insert(accounts)
        .values({
          familyId: family!.id,
          name: "Cash",
          type: "depository",
          currency: "NPR",
          openedOn: "2026-09-09",
          openingBalanceMinor: 9007199254740991
        })
        .returning();
      return Response.json({
        validId: /^[0-9a-f-]{36}$/.test(family!.id),
        date: family!.createdAt instanceof Date,
        json: user!.preferences,
        amount: account!.openingBalanceMinor,
        included: account!.includedInReports
      });
    }
    if (operation === "/rollback") {
      let rejected = false;
      try {
        await db.transaction(async (tx) => {
          await tx.insert(families).values({ name: "must roll back" });
          await Promise.resolve();
          await tx.insert(users).values({
            familyId: "missing-family",
            email: "bad@example.test",
            name: "Bad",
            passwordHash: "disabled"
          });
        });
      } catch {
        rejected = true;
      }
      const rows = await db.select().from(families).where(eq(families.name, "must roll back"));
      return Response.json({ rejected, remaining: rows.length });
    }
    if (operation === "/storage-guards") {
      const [family] = await db.insert(families).values({ name: "Guards" }).returning();
      let rejected = 0;
      for (const amount of ["not-money", "9007199254740992", "1.5"]) {
        try {
          await db.execute(sql`INSERT INTO accounts (family_id, type, name, currency, opening_balance_minor)
            VALUES (${family!.id}, 'depository', 'Invalid', 'NPR', ${amount})`);
        } catch {
          rejected++;
        }
      }
      return Response.json({ rejected });
    }
    if (operation === "/concurrency") {
      const [family] = await db.insert(families).values({ name: "original" }).returning();
      let signal!: () => void;
      const started = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const failedWrite = db
        .transaction(async (tx) => {
          await tx.update(families).set({ name: "uncommitted" }).where(eq(families.id, family!.id));
          signal();
          await Promise.resolve();
          throw new Error("abort");
        })
        .catch(() => undefined);
      await started;
      const read = db.select().from(families).where(eq(families.id, family!.id));
      const [, rows] = await Promise.all([failedWrite, read]);
      return Response.json({ observed: rows[0]!.name });
    }
    if (operation === "/nested") {
      await db.transaction(async (tx) => {
        await tx.insert(families).values({ name: "outer" });
        try {
          await tx.transaction(async (nested) => {
            await nested.insert(families).values({ name: "inner" });
            throw new Error("abort nested");
          });
        } catch {
          /* Outer transaction continues. */
        }
      });
      return Response.json((await db.execute(sql`SELECT name FROM families ORDER BY name`)).rows);
    }
    if (operation === "/api-keys-and-sms") {
      const exec = db as unknown as Executor;
      const user = await registerAccessHousehold(
        exec,
        { subject: "cloud-sms-user", email: "sms-user@example.test" },
        { name: "SMS Tester", familyName: "SMS Family", currency: "NPR", timezone: "UTC" }
      );
      const actor: Actor = {
        userId: user.id,
        familyId: user.familyId,
        email: user.email,
        name: user.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId: "",
        emailVerified: true
      };
      // Dates are generated relative to the real clock so the balance
      // recalculation span (and the test outcome) never depends on today.
      const yesterday = isoDaysAgo(1);

      // Create Bank Accounts
      const laxmiAcct = await createAccount(exec, actor, {
        name: "Laxmi Sunrise Account",
        institution: "Laxmi Sunrise",
        type: "depository",
        currency: "NPR",
        openedOn: yesterday,
        openingBalanceDisplayMinor: 50000,
        includedInReports: true,
        joint: false
      });
      const nabilAcct = await createAccount(exec, actor, {
        name: "Nabil Bank 02167",
        institution: "Nabil Bank",
        type: "depository",
        currency: "NPR",
        openedOn: yesterday,
        openingBalanceDisplayMinor: 100000,
        includedInReports: true,
        joint: false
      });

      // 1. Create API key
      const createdKey = await createApiKey(exec, actor, { name: "iPhone SMS Shortcut" });

      // 2. Verify API key
      const authenticatedActor = await verifyApiKey(exec, createdKey.rawKey);

      // 3. Process Laxmi Credit SMS
      const laxmiText = `Dear Customer, Your #88011052 has been credited by NPR 770.00 on ${ddMmYy(
        yesterday
      )}. Remarks:FPQR-479651654-5834-24:FPQR-479651654-5834-24\n-Laxmi Sunrise`;
      const parsedLaxmi = parseSms(laxmiText, "LAXMI");
      const matchLaxmi = await matchAccountForSms(exec, authenticatedActor!.familyId, {
        bankName: parsedLaxmi.bankName,
        accountDigits: parsedLaxmi.accountDigits,
        sender: "LAXMI"
      });
      const laxmiEntry = await addTransaction(exec, authenticatedActor!, {
        accountId: matchLaxmi!.account.id,
        date: parsedLaxmi.date,
        amountLedgerMinor: -parsedLaxmi.amountMinor, // negative for income
        name: "Freelance Payment",
        externalSource: "sms_shortcut",
        externalId: parsedLaxmi.referenceId
      });

      // 4. Process Nabil Debit SMS
      const nabilText = `Dear Customer, Your 110##02167 has been withdrawn by NPR 24,360.00 on ${ddMmYyyy(
        yesterday
      )} 14:13:30, Remarks: PREPAID CARD 150 T\nDownload App: https://rebrand.ly/nBank`;
      const parsedNabil = parseSms(nabilText, "Nabil_Alert");
      const matchNabil = await matchAccountForSms(exec, authenticatedActor!.familyId, {
        bankName: parsedNabil.bankName,
        accountDigits: parsedNabil.accountDigits,
        sender: "Nabil_Alert"
      });
      const nabilEntry = await addTransaction(exec, authenticatedActor!, {
        accountId: matchNabil!.account.id,
        date: parsedNabil.date,
        amountLedgerMinor: parsedNabil.amountMinor, // positive for expense
        name: "Card Payment",
        externalSource: "sms_shortcut",
        externalId: parsedNabil.referenceId
      });

      // 5. Test Deduplication with identical Nabil SMS
      const nabilDup = await addTransaction(exec, authenticatedActor!, {
        accountId: matchNabil!.account.id,
        date: parsedNabil.date,
        amountLedgerMinor: parsedNabil.amountMinor,
        name: "Card Payment",
        externalSource: "sms_shortcut",
        externalId: parsedNabil.referenceId
      });

      // 6. Test Key Revocation
      await revokeApiKey(exec, actor, createdKey.id);
      const afterRevokeActor = await verifyApiKey(exec, createdKey.rawKey);

      return Response.json({
        keyCreated: !!createdKey.rawKey,
        keyVerified: !!authenticatedActor,
        laxmiMatched: matchLaxmi?.account.id === laxmiAcct.accountId,
        laxmiIncomeLogged: laxmiEntry.duplicated === false,
        nabilMatched: matchNabil?.account.id === nabilAcct.accountId,
        nabilExpenseLogged: nabilEntry.duplicated === false,
        nabilDuplicated: nabilDup.duplicated === true,
        revokedBlocked: afterRevokeActor === null
      });
    }
    if (operation === "/bulk-history") {
      const exec = db as unknown as Executor;
      const user = await registerAccessHousehold(
        exec,
        { subject: "bulk-history-user", email: "bulk-history@example.test" },
        { name: "Bulk", familyName: "Bulk Family", currency: "NPR", timezone: "UTC" }
      );
      const actor: Actor = {
        userId: user.id,
        familyId: user.familyId,
        email: user.email,
        name: user.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId: "",
        emailVerified: true
      };

      // 1) An account whose recalculation spans 500+ days of daily snapshots.
      //    Before the parameter-limit fix this insert failed at 26 days.
      const account = await createAccount(exec, actor, {
        name: "Long History",
        type: "depository",
        currency: "NPR",
        openedOn: isoDaysAgo(500),
        openingBalanceDisplayMinor: 100000,
        includedInReports: true,
        joint: false
      });
      await addTransaction(exec, actor, {
        accountId: account.accountId,
        date: isoDaysAgo(450),
        amountLedgerMinor: 1000,
        name: "Backdated expense"
      });
      const balanceRows = await db.execute(
        sql`SELECT CAST(count(*) AS INTEGER) AS count FROM balances WHERE account_id = ${account.accountId}`
      );
      const longHistoryDays = Number(balanceRows.rows[0]!.count);

      // 2) A Sure import with hundreds of rows (tags, splits, backdated
      //    transactions) into a separate empty household.
      const importUser = await registerAccessHousehold(
        exec,
        { subject: "bulk-import-user", email: "bulk-import@example.test" },
        { name: "Importer", familyName: "Import Family", currency: "NPR", timezone: "UTC" }
      );
      const importActor: Actor = {
        userId: importUser.id,
        familyId: importUser.familyId,
        email: importUser.email,
        name: importUser.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId: "",
        emailVerified: true
      };
      const records: { type: string; data: Record<string, unknown> }[] = [
        {
          type: "Account",
          data: {
            id: "bulk-cash",
            name: "Bulk Cash",
            accountable_type: "Depository",
            balance: "100.00",
            currency: "NPR",
            created_at: isoDaysAgo(600)
          }
        },
        { type: "Category", data: { id: "c1", name: "Bulk category" } },
        { type: "Tag", data: { id: "t1", name: "one" } },
        { type: "Tag", data: { id: "t2", name: "two" } },
        { type: "Tag", data: { id: "t3", name: "three" } }
      ];
      for (let i = 0; i < 300; i++) {
        const base = {
          id: `tx-${i}`,
          account_id: "bulk-cash",
          name: `Bulk transaction ${i}`,
          amount: "1.00",
          currency: "NPR",
          date: isoDaysAgo(1 + (i % 400)),
          category_id: "c1",
          tag_ids: ["t1", "t2", "t3"]
        };
        if (i < 10) {
          records.push({
            type: "Transaction",
            data: {
              ...base,
              split_lines: [
                { amount: "0.50", name: `Split ${i}a` },
                { amount: "0.50", name: `Split ${i}b` }
              ]
            }
          });
        } else {
          records.push({ type: "Transaction", data: base });
        }
      }
      const archive = records.map((record) => JSON.stringify(record)).join("\n");
      const imported = await importSureExport(
        exec,
        importActor,
        "all.ndjson",
        new TextEncoder().encode(archive)
      );
      const importBalanceRows = await db.execute(
        sql`SELECT CAST(count(*) AS INTEGER) AS count FROM balances b
            JOIN accounts a ON a.id = b.account_id
            WHERE a.family_id = ${importActor.familyId}`
      );
      const latestRows = await db.execute(
        sql`SELECT CAST(balance_minor AS TEXT) AS balance_minor FROM balances b
            JOIN accounts a ON a.id = b.account_id
            WHERE a.family_id = ${importActor.familyId}
            ORDER BY b.as_of DESC LIMIT 1`
      );
      return Response.json({
        longHistoryDays,
        imported,
        importBalanceDays: Number(importBalanceRows.rows[0]!.count),
        latestImportBalanceMinor: Number(latestRows.rows[0]!.balance_minor)
      });
    }
    if (operation === "/recurring-repair") {
      const exec = db as unknown as Executor;
      const user = await registerAccessHousehold(
        exec,
        { subject: "recurring-repair-user", email: "recurring-repair@example.test" },
        { name: "Repair", familyName: "Repair Family", currency: "NPR", timezone: "UTC" }
      );
      const actor: Actor = {
        userId: user.id,
        familyId: user.familyId,
        email: user.email,
        name: user.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId: "",
        emailVerified: true
      };
      const account = await createAccount(exec, actor, {
        name: "Repair Cash",
        type: "depository",
        currency: "NPR",
        openedOn: isoDaysAgo(30),
        openingBalanceDisplayMinor: 0,
        includedInReports: true,
        joint: false
      });
      // Occurrences on isoDaysAgo(7) and today are due.
      const start = isoDaysAgo(7);
      await createSeries(exec, actor, {
        accountId: account.accountId,
        name: "Weekly bill",
        amountLedgerMinor: 100,
        frequency: "weekly",
        config: { weekday: new Date(`${start}T00:00:00Z`).getUTCDay() },
        nextDue: start
      });
      const result = await postDueSeries(exec);
      const entryRows = await db.execute(
        sql`SELECT CAST(count(*) AS INTEGER) AS count FROM entries WHERE account_id = ${account.accountId}`
      );
      // Repair intent commits with the occurrences: one pending
      // maintenance:balances job (both occurrences share the dedupe key).
      const jobRows = await db.execute(
        sql`SELECT CAST(count(*) AS INTEGER) AS count FROM jobs
            WHERE queue = 'maintenance:balances'
              AND dedupe_key = ${`balance-repair:${account.accountId}`}
              AND status = 'pending'`
      );
      // This is exactly what the maintenance:balances queue handler runs.
      await recalculateAllActiveAccounts(exec);
      const balanceRows = await db.execute(
        sql`SELECT CAST(balance_minor AS TEXT) AS balance_minor FROM balances
            WHERE account_id = ${account.accountId} ORDER BY as_of DESC LIMIT 1`
      );
      const again = await postDueSeries(exec);
      return Response.json({
        result,
        entries: Number(entryRows.rows[0]!.count),
        repairJobsPending: Number(jobRows.rows[0]!.count),
        balanceMinor: Number(balanceRows.rows[0]!.balance_minor),
        again
      });
    }
    if (operation === "/mcp-oauth") {
      const exec = db as unknown as Executor;
      const config: McpConfig = {
        resourceUrl: "https://meridian.test/mcp",
        issuerUrl: "https://meridian.test",
        cimdAllowlist: [],
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 30 * 24 * 3600,
        authorizationCodeTtlSeconds: 300,
        grantTtlSeconds: 90 * 24 * 3600
      };
      const user = await registerAccessHousehold(
        exec,
        { subject: "cloud-mcp-user", email: "mcp@example.test" },
        { name: "MCP Tester", familyName: "MCP Family", currency: "NPR", timezone: "UTC" }
      );
      const other = await registerAccessHousehold(
        exec,
        { subject: "cloud-mcp-other", email: "mcp-other@example.test" },
        { name: "Other", familyName: "Other Family", currency: "NPR", timezone: "UTC" }
      );
      const actor: Actor = {
        userId: user.id,
        familyId: user.familyId,
        email: user.email,
        name: user.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId: "cloud-session",
        emailVerified: true
      };
      const redirectUri = "http://127.0.0.1:8910/callback";
      const { client: dcr } = await registerOAuthClient(exec, {
        clientName: "Cloud Claude",
        redirectUris: [redirectUri]
      });
      const client = (await resolveOAuthClient(exec, dcr.id))!;
      const pkcePair = () => {
        const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        return { verifier, challenge };
      };
      const newCode = async () => {
        const { verifier, challenge } = pkcePair();
        const request = await validateAuthorizeRequest(
          exec,
          {
            clientId: client.clientId,
            redirectUri,
            responseType: "code",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "finance:read offline_access",
            resource: config.resourceUrl,
            state: null
          },
          config
        );
        const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });
        const consumed = await consumeAuthorizationRequest(exec, {
          requestId: record.id,
          actor,
          csrfToken
        });
        const { code } = await approveAuthorizationRequest(exec, consumed, config);
        return { code, verifier };
      };
      const exchange = (code: string, verifier: string) =>
        exchangeAuthorizationCode(
          exec,
          { code, redirectUri, codeVerifier: verifier, resource: config.resourceUrl },
          client,
          config
        );
      const isInvalidGrant = (e: unknown) => e instanceof OAuthError && e.error === "invalid_grant";

      // Happy path + per-call resolution.
      const f1 = await newCode();
      const t1 = await exchange(f1.code, f1.verifier);
      const access1 = await resolveMcpAccess(exec, t1.accessToken, config);

      // Sequential code replay kills the family.
      let codeReplayRejected = false;
      try {
        await exchange(f1.code, f1.verifier);
      } catch (e) {
        codeReplayRejected = isInvalidGrant(e);
      }
      const replayKillsTokens = (await resolveMcpAccess(exec, t1.accessToken, config)) === null;

      // Concurrent exchange of one code: exactly one winner, family revoked.
      const f2 = await newCode();
      const race = await Promise.allSettled([
        exchange(f2.code, f2.verifier),
        exchange(f2.code, f2.verifier)
      ]);
      const raceWinners = race.filter((r) => r.status === "fulfilled");
      const concurrentExchangeSingleWinner = raceWinners.length === 1;
      const winnerTokens =
        raceWinners.length === 1
          ? (raceWinners[0] as PromiseFulfilledResult<typeof t1>).value
          : null;
      const concurrentExchangeFamilyRevoked = winnerTokens
        ? (await resolveMcpAccess(exec, winnerTokens.accessToken, config)) === null
        : false;

      // Refresh rotation + sequential reuse detection.
      const f3 = await newCode();
      const t3 = await exchange(f3.code, f3.verifier);
      const pair2 = await refreshOAuthToken(
        exec,
        { refreshToken: t3.refreshToken! },
        client,
        config
      );
      let refreshReuseRejected = false;
      try {
        await refreshOAuthToken(exec, { refreshToken: t3.refreshToken! }, client, config);
      } catch (e) {
        refreshReuseRejected = isInvalidGrant(e);
      }
      const refreshReuseKillsFamily =
        (await resolveMcpAccess(exec, pair2.accessToken, config)) === null;

      // Concurrent refresh with one token: exactly one winner.
      const f4 = await newCode();
      const t4 = await exchange(f4.code, f4.verifier);
      const refreshRace = await Promise.allSettled([
        refreshOAuthToken(exec, { refreshToken: t4.refreshToken! }, client, config),
        refreshOAuthToken(exec, { refreshToken: t4.refreshToken! }, client, config)
      ]);
      const concurrentRefreshSingleWinner =
        refreshRace.filter((r) => r.status === "fulfilled").length === 1;

      // P1-2 (cloud adaptation): after a reuse invalidation, a
      // DESCENDANT refresh must be rejected and the descendant pair
      // dead. The DO executor serializes whole transactions behind its
      // mutex, so the Postgres lock interleavings have no analogue
      // here; the invariant outcome is what is asserted.
      const f6 = await newCode();
      const t6 = await exchange(f6.code, f6.verifier);
      const pair6 = await refreshOAuthToken(
        exec,
        { refreshToken: t6.refreshToken! },
        client,
        config
      );
      try {
        await refreshOAuthToken(exec, { refreshToken: t6.refreshToken! }, client, config);
      } catch {
        /* replaying the rotated-out token: invalidates the family */
      }
      let descendantRefreshRejected = false;
      try {
        await refreshOAuthToken(exec, { refreshToken: pair6.refreshToken! }, client, config);
      } catch (e) {
        descendantRefreshRejected = isInvalidGrant(e);
      }
      const descendantPairDead = (await resolveMcpAccess(exec, pair6.accessToken, config)) === null;

      // P2-8: the STORED resource governs refresh — a config change
      // must not retarget stored credentials to the new resource.
      const configB = { ...config, resourceUrl: "https://other-resource.test/mcp" };
      const f7 = await newCode();
      const t7 = await exchange(f7.code, f7.verifier);
      let resourceChangeRefreshRejected = false;
      try {
        await refreshOAuthToken(
          exec,
          { refreshToken: t7.refreshToken!, resource: configB.resourceUrl },
          client,
          configB
        );
      } catch (e) {
        resourceChangeRefreshRejected = isInvalidGrant(e);
      }
      const resourceChangeAccessRejected =
        (await resolveMcpAccess(exec, t7.accessToken, configB)) === null;

      // P2-6: private_key_jwt assertions — exp required, jti claimed
      // exactly once (sequential replay rejected here; the concurrent
      // claim race is covered on Postgres where connections are real).
      clearCimdCaches();
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "cloud-claims-key";
      const claimsUrl = "https://claims.example.test/client.json";
      const claimsDoc = {
        client_id: claimsUrl,
        client_name: "Cloud Claims",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys: [jwk] }
      };
      const claimsFetcher: MetadataFetcher = async () => claimsDoc;
      const claimsConfig = { ...config, cimdAllowlist: [claimsUrl] };
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "cloud-claims-key" })
        .setIssuer(claimsUrl)
        .setSubject(claimsUrl)
        .setAudience("https://meridian.test/oauth/token")
        .setIssuedAt()
        .setExpirationTime("2m")
        .setJti("cloud-jti-1")
        .sign(privateKey);
      const authArgs = {
        clientId: claimsUrl,
        clientAssertion: assertion,
        clientAssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
      };
      let assertionFirstOk = false;
      try {
        await authenticateOAuthClient(exec, authArgs, claimsConfig, claimsFetcher);
        assertionFirstOk = true;
      } catch {
        assertionFirstOk = false;
      }
      let assertionReplayRejected = false;
      try {
        await authenticateOAuthClient(exec, authArgs, claimsConfig, claimsFetcher);
      } catch (e) {
        assertionReplayRejected = e instanceof OAuthError && e.error === "invalid_client";
      }
      const assertionNow = Math.floor(Date.now() / 1000);
      const signTimedAssertion = (iat: number, exp: number, jti: string) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "cloud-claims-key" })
          .setIssuer(claimsUrl)
          .setSubject(claimsUrl)
          .setAudience("https://meridian.test/oauth/token")
          .setIssuedAt(iat)
          .setExpirationTime(exp)
          .setJti(jti)
          .sign(privateKey);
      const skewedAssertion = await signTimedAssertion(
        assertionNow - 120,
        assertionNow - 5,
        "cloud-skew"
      );
      const skewedArgs = { ...authArgs, clientAssertion: skewedAssertion };
      await authenticateOAuthClient(exec, skewedArgs, claimsConfig, claimsFetcher);
      let assertionSkewReplayRejected = false;
      try {
        await authenticateOAuthClient(exec, skewedArgs, claimsConfig, claimsFetcher);
      } catch (e) {
        assertionSkewReplayRejected = e instanceof OAuthError && e.error === "invalid_client";
      }
      let assertionFutureRejected = false;
      try {
        await authenticateOAuthClient(
          exec,
          {
            ...authArgs,
            clientAssertion: await signTimedAssertion(
              assertionNow + 3600,
              assertionNow + 3720,
              "cloud-future"
            )
          },
          claimsConfig,
          claimsFetcher
        );
      } catch (e) {
        assertionFutureRejected = e instanceof OAuthError && e.error === "invalid_client";
      }
      const noExpAssertion = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "cloud-claims-key" })
        .setIssuer(claimsUrl)
        .setSubject(claimsUrl)
        .setAudience("https://meridian.test/oauth/token")
        .setIssuedAt()
        .setJti("cloud-jti-2")
        .sign(privateKey);
      let assertionMissingExpRejected = false;
      try {
        await authenticateOAuthClient(
          exec,
          { ...authArgs, clientAssertion: noExpAssertion },
          claimsConfig,
          claimsFetcher
        );
      } catch (e) {
        assertionMissingExpRejected = e instanceof OAuthError && e.error === "invalid_client";
      }

      // Household move: rejected, never redirected to the new household.
      const f5 = await newCode();
      const t5 = await exchange(f5.code, f5.verifier);
      await exec.execute(sql`UPDATE users SET family_id = ${other.familyId} WHERE id = ${user.id}`);
      const householdMoveRejected = (await resolveMcpAccess(exec, t5.accessToken, config)) === null;

      // Consent record bindings: CSRF + single use.
      const { challenge } = pkcePair();
      const request6 = await validateAuthorizeRequest(
        exec,
        {
          clientId: client.clientId,
          redirectUri,
          responseType: "code",
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          scope: "finance:read",
          resource: config.resourceUrl,
          state: null
        },
        config
      );
      const { record: rec6, csrfToken: csrf6 } = await createAuthorizationRequest(exec, {
        actor,
        request: request6
      });
      let consentCsrfRejected = false;
      try {
        await consumeAuthorizationRequest(exec, { requestId: rec6.id, actor, csrfToken: "bogus" });
      } catch {
        consentCsrfRejected = true;
      }
      await consumeAuthorizationRequest(exec, { requestId: rec6.id, actor, csrfToken: csrf6 });
      let consentSingleUse = false;
      try {
        await consumeAuthorizationRequest(exec, { requestId: rec6.id, actor, csrfToken: csrf6 });
      } catch {
        consentSingleUse = true;
      }

      // CIMD gate on the Workers backend: fetching is restricted to
      // operator-allowlisted URLs (no DNS pinning exists here).
      const docUrl = "https://clients.example.test/client.json";
      const fakeFetcher: MetadataFetcher = async () => ({
        client_id: docUrl,
        client_name: "CIMD",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "none"
      });
      const cimdBlockedWithoutAllowlist =
        (await resolveOAuthClient(exec, docUrl, fakeFetcher, [])) === null;
      const cimdAllowedWithAllowlist =
        (await resolveOAuthClient(exec, docUrl, fakeFetcher, [docUrl])) !== null;

      return Response.json({
        resolved:
          access1 !== null &&
          access1.actor.familyId === user.familyId &&
          access1.actor.platformRole === "user",
        codeReplayRejected,
        replayKillsTokens,
        concurrentExchangeSingleWinner,
        concurrentExchangeFamilyRevoked,
        refreshReuseRejected,
        refreshReuseKillsFamily,
        concurrentRefreshSingleWinner,
        householdMoveRejected,
        consentCsrfRejected,
        consentSingleUse,
        cimdBlockedWithoutAllowlist,
        cimdAllowedWithAllowlist,
        descendantRefreshRejected,
        descendantPairDead,
        resourceChangeRefreshRejected,
        resourceChangeAccessRejected,
        assertionFirstOk,
        assertionReplayRejected,
        assertionSkewReplayRejected,
        assertionFutureRejected,
        assertionMissingExpRejected
      });
    }
    if (operation === "/mcp-ssrf-redirect") {
      // P1-4: on the Workers path (resolveHost is null in production)
      // the CIMD allowlist must be enforced before EVERY hop — an
      // approved URL redirecting off-allowlist must never be fetched.
      const APPROVED = "https://approved.example/client.json";
      const APPROVED2 = "https://approved.example/jwks.json";
      const UNAPPROVED = "https://unapproved.example/client.json";
      const seenBlocked: string[] = [];
      const redirectOut: MetadataTransport = async (url) => {
        seenBlocked.push(url.toString());
        if (url.toString() === APPROVED) {
          return { status: 302, contentType: null, location: UNAPPROVED, body: "" };
        }
        return {
          status: 200,
          contentType: "application/json",
          location: null,
          body: "{}"
        };
      };
      const fetcherBlocked = createMetadataFetcher({
        resolveHost: async () => null,
        transport: redirectOut
      });
      let blockedThrew = false;
      try {
        await fetcherBlocked(APPROVED, { allowlist: [APPROVED] });
      } catch {
        blockedThrew = true;
      }
      const redirectToUnapprovedBlocked = blockedThrew && !seenBlocked.includes(UNAPPROVED);

      const seenOk: string[] = [];
      const redirectIn: MetadataTransport = async (url) => {
        seenOk.push(url.toString());
        if (url.toString() === APPROVED) {
          return { status: 302, contentType: null, location: APPROVED2, body: "" };
        }
        return {
          status: 200,
          contentType: "application/json",
          location: null,
          body: JSON.stringify({ ok: true })
        };
      };
      const fetcherOk = createMetadataFetcher({
        resolveHost: async () => null,
        transport: redirectIn
      });
      let positiveDoc: unknown = null;
      try {
        positiveDoc = await fetcherOk(APPROVED, { allowlist: [APPROVED, APPROVED2] });
      } catch {
        positiveDoc = null;
      }
      const redirectWithinAllowlistAllowed =
        (positiveDoc as { ok?: boolean } | null)?.ok === true && seenOk.length === 2;

      return Response.json({ redirectToUnapprovedBlocked, redirectWithinAllowlistAllowed });
    }
    if (operation === "/mcp-tools") {
      const exec = db as unknown as Executor;
      const config: McpConfig = {
        resourceUrl: "https://meridian.test/mcp",
        issuerUrl: "https://meridian.test",
        cimdAllowlist: [],
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 30 * 24 * 3600,
        authorizationCodeTtlSeconds: 300,
        grantTtlSeconds: 90 * 24 * 3600
      };
      const user = await registerAccessHousehold(
        exec,
        { subject: "cloud-mcp-tools-user", email: "mcp-tools@example.test" },
        { name: "Tools Tester", familyName: "Tools Family", currency: "NPR", timezone: "UTC" }
      );
      const other = await registerAccessHousehold(
        exec,
        { subject: "cloud-mcp-tools-other", email: "mcp-tools-other@example.test" },
        { name: "Other", familyName: "Other Tools Family", currency: "NPR", timezone: "UTC" }
      );
      const actorFor = (u: typeof user, sessionId: string): Actor => ({
        userId: u.id,
        familyId: u.familyId,
        email: u.email,
        name: u.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId,
        emailVerified: true
      });
      const actor = actorFor(user, "cloud-tools-session");
      const otherActor = actorFor(other, "cloud-tools-other-session");
      const account = await createAccount(exec, actor, {
        name: "Tools Cash",
        type: "depository",
        currency: "NPR",
        openedOn: isoDaysAgo(10),
        openingBalanceDisplayMinor: 100_000,
        includedInReports: true,
        joint: false
      });
      await addTransaction(exec, actor, {
        accountId: account.accountId,
        date: isoDaysAgo(0),
        amountLedgerMinor: 25_000,
        name: "Weekly shop",
        merchant: "SuperStore",
        notes: "cloud-secret-note"
      });
      const otherAccount = await createAccount(exec, otherActor, {
        name: "Other Cash",
        type: "depository",
        currency: "NPR",
        openedOn: isoDaysAgo(10),
        openingBalanceDisplayMinor: 50_000,
        includedInReports: true,
        joint: false
      });
      await addTransaction(exec, otherActor, {
        accountId: otherAccount.accountId,
        date: isoDaysAgo(0),
        amountLedgerMinor: 9_999,
        name: "Other purchase",
        merchant: "OtherFamMerchant"
      });

      const redirectUri = "http://127.0.0.1:8910/callback";
      const { client: dcr } = await registerOAuthClient(exec, {
        clientName: "Cloud Tools",
        redirectUris: [redirectUri]
      });
      const client = (await resolveOAuthClient(exec, dcr.id))!;
      const connect = async (scope: string) => {
        const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const request = await validateAuthorizeRequest(
          exec,
          {
            clientId: client.clientId,
            redirectUri,
            responseType: "code",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope,
            resource: config.resourceUrl,
            state: null
          },
          config
        );
        const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });
        const consumed = await consumeAuthorizationRequest(exec, {
          requestId: record.id,
          actor,
          csrfToken
        });
        const { code } = await approveAuthorizationRequest(exec, consumed, config);
        return exchangeAuthorizationCode(
          exec,
          { code, redirectUri, codeVerifier: verifier, resource: config.resourceUrl },
          client,
          config
        );
      };
      type ToolOutcome = {
        isError?: boolean;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data?: any;
      };
      const callTool = async (
        accessToken: string,
        name: string,
        args: Record<string, unknown> = {}
      ): Promise<ToolOutcome> => {
        const access = await resolveMcpAccess(exec, accessToken, config);
        if (!access) return { isError: true };
        const res = await handleMcpRequest(
          new Request("https://meridian.test/mcp", {
            method: "POST",
            headers: {
              host: "meridian.test",
              "content-type": "application/json",
              accept: "application/json, text/event-stream"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args }
            })
          }),
          { exec, access, config }
        );
        const text = await res.text();
        let parsed: { result?: { isError?: boolean; structuredContent?: unknown } } | null = null;
        if (res.headers.get("content-type")?.includes("text/event-stream")) {
          for (const line of text.split("\n")) {
            if (line.startsWith("data:")) {
              try {
                parsed = JSON.parse(line.slice(5));
              } catch {
                /* keep scanning */
              }
            }
          }
        } else if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        return { isError: parsed?.result?.isError, data: parsed?.result?.structuredContent };
      };

      const full = await connect(
        "finance:read transactions:read transactions:notes offline_access"
      );
      const txnOnly = await connect("transactions:read offline_access");
      const financeOnly = await connect("finance:read offline_access");

      const accountsRes = await callTool(full.accessToken, "list_accounts");
      const listAccountsOk =
        accountsRes.data?.accounts?.length === 1 &&
        accountsRes.data.accounts[0].amountMinor === "75000" &&
        accountsRes.data.accounts[0].currency === "NPR";

      const searchRes = await callTool(full.accessToken, "search_transactions", {
        query: "Weekly"
      });
      const searchOk =
        searchRes.data?.page?.totalMatching === 1 &&
        searchRes.data.transactions[0].amountMinor === "25000";

      const noNotesList = await callTool(txnOnly.accessToken, "search_transactions", {});
      const notesExcludedWithoutScope =
        noNotesList.data?.notesIncluded === false &&
        Array.isArray(noNotesList.data?.transactions) &&
        noNotesList.data.transactions.every((t: { notes: unknown }) => t.notes === null);
      const noNotesSearch = await callTool(txnOnly.accessToken, "search_transactions", {
        query: "cloud-secret-note"
      });
      const noteTextNotSearchable = noNotesSearch.data?.page?.totalMatching === 0;
      const withNotes = await callTool(full.accessToken, "search_transactions", {
        query: "cloud-secret-note"
      });
      const notesIncludedWithScope =
        withNotes.data?.notesIncluded === true &&
        withNotes.data?.page?.totalMatching === 1 &&
        withNotes.data.transactions[0].notes === "cloud-secret-note";

      const financeDenied = await callTool(txnOnly.accessToken, "list_accounts");
      const financeDeniedForTransactionsGrant = financeDenied.isError === true;
      const searchDenied = await callTool(financeOnly.accessToken, "search_transactions");
      const searchDeniedForFinanceGrant = searchDenied.isError === true;

      const cross = await callTool(full.accessToken, "search_transactions", {
        query: "OtherFamMerchant"
      });
      const crossHouseholdIsolated = cross.data?.page?.totalMatching === 0;

      const breakdown = await callTool(full.accessToken, "get_spending_breakdown", {
        groupBy: "merchant"
      });
      const breakdownMerchantOk =
        Array.isArray(breakdown.data?.groups) &&
        breakdown.data.groups.some(
          (g: { merchant: string; total: { amountMinor: string } }) =>
            g.merchant === "SuperStore" && g.total.amountMinor === "25000"
        );

      const summary = await callTool(full.accessToken, "get_financial_summary");
      const summaryOk = summary.isError !== true && summary.data?.household?.baseCurrency === "NPR";

      // P1-1: a ceiling-restricted summary excludes the second account
      // from every figure, not just the account list.
      const vault = await createAccount(exec, actor, {
        name: "Excluded Vault",
        type: "depository",
        currency: "NPR",
        openedOn: isoDaysAgo(10),
        openingBalanceDisplayMinor: 900_000,
        includedInReports: true,
        joint: false
      });
      await addTransaction(exec, actor, {
        accountId: vault.accountId,
        date: isoDaysAgo(0),
        amountLedgerMinor: 40_000,
        name: "Vault spend"
      });
      const connectWithCeiling = async (accountIds: string[]) => {
        const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const request = await validateAuthorizeRequest(
          exec,
          {
            clientId: client.clientId,
            redirectUri,
            responseType: "code",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "finance:read offline_access",
            resource: config.resourceUrl,
            state: null
          },
          config
        );
        const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });
        const consumed = await consumeAuthorizationRequest(exec, {
          requestId: record.id,
          actor,
          csrfToken
        });
        const { grant, code } = await approveAuthorizationRequest(exec, consumed, config);
        await exec.execute(
          sql`UPDATE oauth_grants SET account_ids = ${JSON.stringify(accountIds)} WHERE id = ${grant.id}`
        );
        return exchangeAuthorizationCode(
          exec,
          { code, redirectUri, codeVerifier: verifier, resource: config.resourceUrl },
          client,
          config
        );
      };
      const ceilingTokens = await connectWithCeiling([account.accountId]);
      const ceilingSummary = await callTool(ceilingTokens.accessToken, "get_financial_summary");
      const summaryExcludesCeilingAccount =
        ceilingSummary.data?.accounts?.length === 1 &&
        ceilingSummary.data.netWorth?.amountMinor === "75000" &&
        ceilingSummary.data.expensesThisMonth?.amountMinor === "25000";

      // P2-7a: deleting the vault's snapshot for today makes today's
      // net-worth point partial — it must be flagged, not complete.
      await exec.execute(
        sql`DELETE FROM balances WHERE account_id = ${vault.accountId} AND as_of = ${isoDaysAgo(0)}`
      );
      const history = await callTool(full.accessToken, "get_net_worth_history", { days: 1 });
      const netWorthPartialFlagged =
        history.data?.points?.length === 1 &&
        history.data.points[0].complete === false &&
        Array.isArray(history.data.points[0].missingAccountIds) &&
        history.data.points[0].missingAccountIds.includes(vault.accountId) &&
        history.data.coverage?.complete === false &&
        history.data.coverage?.missingDays === 0;

      return Response.json({
        listAccountsOk,
        searchOk,
        notesExcludedWithoutScope,
        noteTextNotSearchable,
        notesIncludedWithScope,
        financeDeniedForTransactionsGrant,
        searchDeniedForFinanceGrant,
        crossHouseholdIsolated,
        breakdownMerchantOk,
        summaryOk,
        summaryExcludesCeilingAccount,
        netWorthPartialFlagged
      });
    }
    if (operation === "/mcp-settings") {
      // Stage 4: consent account picker + Connected AI agents settings
      // data (listConnectionsForUser) on the cloud backend.
      const exec = db as unknown as Executor;
      const config: McpConfig = {
        resourceUrl: "https://meridian.test/mcp",
        issuerUrl: "https://meridian.test",
        cimdAllowlist: [],
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 30 * 24 * 3600,
        authorizationCodeTtlSeconds: 300,
        grantTtlSeconds: 90 * 24 * 3600
      };
      const user = await registerAccessHousehold(
        exec,
        { subject: "cloud-mcp-settings-user", email: "mcp-settings@example.test" },
        { name: "Settings Tester", familyName: "Settings Family", currency: "NPR", timezone: "UTC" }
      );
      const other = await registerAccessHousehold(
        exec,
        { subject: "cloud-mcp-settings-other", email: "mcp-settings-other@example.test" },
        { name: "Other", familyName: "Other Settings Family", currency: "NPR", timezone: "UTC" }
      );
      const actorFor = (u: typeof user, sessionId: string): Actor => ({
        userId: u.id,
        familyId: u.familyId,
        email: u.email,
        name: u.name,
        familyRole: "admin",
        platformRole: "user",
        sessionId,
        emailVerified: true
      });
      const actor = actorFor(user, "cloud-settings-session");
      const otherActor = actorFor(other, "cloud-settings-other-session");
      const accountArgs = {
        type: "depository" as const,
        currency: "NPR",
        openedOn: isoDaysAgo(10),
        openingBalanceDisplayMinor: 100_000,
        includedInReports: true,
        joint: false
      };
      const kept = await createAccount(exec, actor, { ...accountArgs, name: "Settings Cash" });
      await createAccount(exec, actor, { ...accountArgs, name: "Settings Vault" });
      const foreign = await createAccount(exec, otherActor, {
        ...accountArgs,
        name: "Foreign Cash"
      });

      const redirectUri = "http://127.0.0.1:8910/callback";
      const { client: dcr } = await registerOAuthClient(exec, {
        clientName: "Cloud Settings",
        redirectUris: [redirectUri]
      });
      const client = (await resolveOAuthClient(exec, dcr.id))!;
      const newRequest = async () => {
        const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const request = await validateAuthorizeRequest(
          exec,
          {
            clientId: client.clientId,
            redirectUri,
            responseType: "code",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "finance:read offline_access",
            resource: config.resourceUrl,
            state: null
          },
          config
        );
        const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });
        const consumed = await consumeAuthorizationRequest(exec, {
          requestId: record.id,
          actor,
          csrfToken
        });
        return { consumed, verifier };
      };

      // Picker: a foreign account id rejects the whole approval.
      let selectionRejectsForeign = false;
      try {
        const { consumed } = await newRequest();
        await approveAuthorizationRequest(exec, consumed, config, {
          actor,
          accountIds: [foreign.accountId]
        });
      } catch (e) {
        selectionRejectsForeign = e instanceof OAuthError && e.error === "invalid_request";
      }

      // Picker: the validated subset is stored on the grant.
      const { consumed, verifier } = await newRequest();
      const { grant, code } = await approveAuthorizationRequest(exec, consumed, config, {
        actor,
        accountIds: [kept.accountId]
      });
      const ceilingStored = grant.accountIds.length === 1 && grant.accountIds[0] === kept.accountId;

      const before = await listConnectionsForUser(exec, user.id);
      const listShowsConnection =
        before.length === 1 &&
        before[0]!.grant.id === grant.id &&
        before[0]!.familyName === "Settings Family" &&
        before[0]!.status === "active" &&
        before[0]!.grant.lastUsedAt === null &&
        before[0]!.accounts?.length === 1 &&
        before[0]!.accounts[0]!.name === "Settings Cash" &&
        before[0]!.history.map((h) => h.action).join(",") === "oauth_grant.created";
      const otherUserListEmpty = (await listConnectionsForUser(exec, other.id)).length === 0;

      // A real tool call advances last-used and lands in the history.
      const tokens = await exchangeAuthorizationCode(
        exec,
        { code, redirectUri, codeVerifier: verifier, resource: config.resourceUrl },
        client,
        config
      );
      const access = await resolveMcpAccess(exec, tokens.accessToken, config);
      let toolCalled = false;
      let toolResponseText = "";
      if (access) {
        const res = await handleMcpRequest(
          new Request("https://meridian.test/mcp", {
            method: "POST",
            headers: {
              host: "meridian.test",
              "content-type": "application/json",
              accept: "application/json, text/event-stream"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "get_financial_summary", arguments: {} }
            })
          }),
          { exec, access, config }
        );
        // The body must be consumed: the handler's trailing work (the
        // audit insert) completes as the SSE stream is read, exactly as
        // a real client reading the response would observe.
        toolResponseText = await res.text();
        toolCalled = res.status === 200 && !toolResponseText.includes('"isError":true');
      }
      const afterCall = await listConnectionsForUser(exec, user.id);
      const lastUsedAdvances =
        toolCalled &&
        afterCall[0]!.grant.lastUsedAt !== null &&
        afterCall[0]!.history.some(
          (h) => h.action === "mcp.tool_called" && h.tool === "get_financial_summary"
        );

      // Disconnect: status flips, history records it, tokens die.
      await revokeGrant(exec, grant.id, user.id);
      const afterRevoke = await listConnectionsForUser(exec, user.id);
      const revokedStatusShown =
        afterRevoke[0]!.status === "revoked" &&
        afterRevoke[0]!.history[0]!.action === "oauth_grant.revoked";
      const revokeKillsAccess = (await resolveMcpAccess(exec, tokens.accessToken, config)) === null;

      return Response.json({
        ceilingStored,
        selectionRejectsForeign,
        listShowsConnection,
        otherUserListEmpty,
        lastUsedAdvances,
        revokedStatusShown,
        revokeKillsAccess
      });
    }
    return new Response("Unknown probe", { status: 404 });
  }
}

const worker = {
  fetch(
    request: Request,
    env: { PROBE: { getByName(name: string): { fetch(request: Request): Promise<Response> } } }
  ) {
    return env.PROBE.getByName(new URL(request.url).pathname).fetch(request);
  }
};

export default worker;
