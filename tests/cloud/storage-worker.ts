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
import { createInvitation, acceptInvitationWithAccess } from "../../src/server/domain/invitations";
import { setBudget } from "../../src/server/domain/budgets";
import { buildFamilyExport } from "../../src/server/domain/exports";
import { ensureSchedules, runDueCrons } from "../../src/server/queue/worker-loop";
import { importSureExport } from "../../src/server/domain/sure-import";
import { connectMeroShare, syncMeroShareConnection } from "../../src/server/domain/meroshare";
import { mockMeroShareFetch } from "./meroshare-fixture";
import { splitEntry } from "../../src/server/domain/splits";
import { claimBatch, completeJob, enqueue } from "../../src/server/queue";
import { createApiKey, verifyApiKey, revokeApiKey } from "../../src/server/domain/api-keys";
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
    if (operation === "/ledger" || operation === "/import-meroshare") {
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
      const monthly = await incomeExpenseSeries(exec, family!, user.id, 1);
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
