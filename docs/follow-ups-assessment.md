# Follow-ups assessment: inert feature flags and scheduled MeroShare sync

Assessment only — nothing in this document is implemented. It covers two
feature flags that exist without implementations (`net_worth_projections`,
`monthly_digest_email`) and one considered capability (scheduled MeroShare
sync), and gives the owner a recommendation for each.

## How feature flags work today

Flags live in the `feature_flags` table and are managed by
`src/server/flags/index.ts`: `ensureDefaultFlags` seeds the two keys below
(both default **disabled**), the super-admin console (`src/app/admin/`) lists
them and toggles them via `setFlagEnabled`, and `isFlagEnabled` is the read
API product code is supposed to consult.

**Neither flag has any consumer.** `isFlagEnabled` has no call sites outside
`src/server/flags/index.ts`, so toggling either flag in the admin console
changes nothing anywhere in the product. Both descriptions are prefixed
"Preview:", which implies a capability that does not exist. That mismatch —
an operator-facing switch wired to nothing — is the core problem this
assessment addresses.

---

## 1. `net_worth_projections` — "project net worth trend into the next quarter"

### Current state

Flag only. The dashboard (`src/app/(app)/page.tsx`) renders historical net
worth via `netWorthSeries` in `src/server/domain/reports.ts`, computed from
the materialized daily `balances` snapshots. Nothing projects anything.

### What implementing it would involve

- **A projection model, which is a design decision first.** Two plausible
  inputs exist: (a) trend extrapolation over historical snapshots, and
  (b) deterministic forward simulation — current balances plus the future
  occurrences of active recurring series (`src/server/domain/recurring.ts`)
  over the next quarter. (b) is more defensible for a finance tool but only
  covers scheduled flows; (a) covers everything but invents a trend.
- **New service code** in `src/server/domain/reports.ts` (a
  `netWorthProjectionSeries` alongside `netWorthSeries`), reusing the
  existing FX-completeness handling: amounts without a rate are already
  excluded from converted totals with a diagnostic, and a projection would
  silently inherit that undercount unless the UI carries the same warning.
- **UI work** on the dashboard chart: a visually distinct projected segment
  (dashed/different tone) with an explicit "projection, not a guarantee"
  label, gated by `isFlagEnabled` — the flag's first real consumer.
- **Tests**: projection math against seeded snapshots + recurring series,
  including paused series and valuation-driven accounts.

### Risks

- Presenting an estimate with the same visual authority as ledger fact
  undermines the app's core promise ("know exactly where you stand").
- Valuation-driven accounts (MeroShare portfolios) move with the market and
  cannot be projected deterministically; including them at a flat value and
  excluding them are both misleading in different ways.
- Multi-currency households with missing historical rates already have
  incomplete totals; a projection compounds the gap.

### Recommendation: **remove the flag**

Delete `net_worth_projections` from `DEFAULT_FLAGS` (and let the seeded row
be cleaned up) until projections get a dedicated design. An inert toggle
labeled "Preview" invites an operator to enable it and believe the feature
exists. If projections are pursued later, re-add the flag together with its
first consumer, after settling the model question above.

---

## 2. `monthly_digest_email` — "send a monthly summary email to family members"

### Current state

Flag only — but unlike projections, every piece of infrastructure a digest
needs already exists and is in production use:

- **Mail**: `createMailer()` (`src/server/security/mailer.ts`) with
  console/SMTP transports, plus the durable `email` job queue (retries,
  dead-letter) registered in `src/server/queue/jobs.ts`.
- **Scheduling**: `CRON_DEFINITIONS` + `ensureSchedules` in the same file
  already run `recurring:post` every 30 minutes and nightly maintenance;
  adding a monthly cron entry is a known pattern.
- **Content**: `dashboardSummary`, `incomeExpenseSeries`, and
  `spendingByCategory` (`src/server/domain/reports.ts`) plus
  `monthRangeOf`/`currentMonthRange` already compute exactly the
  previous-month summary a digest would send.

### What implementing it would involve

- A new cron definition (e.g. early on the 1st of the month) and a
  `digest:monthly` job handler in `src/server/queue/jobs.ts` that iterates
  families, composes each family's previous-month summary from the report
  services, and enqueues one `email` job per recipient.
- **A per-member opt-out.** No email-preference field exists today; add one
  (a column on `users` or a preferences record) defaulting to **off**, and
  only send to members who opted in and have a verified email address.
  Sending financial summaries to every member by default would be a
  privacy regression.
- A plain-text template (the mailer is text-first today) that carries
  totals, not transaction-level detail, and links back to the app.
- Tests: handler composition against a seeded family (console mailer),
  opt-out and unverified-address exclusion, and a no-activity family
  receiving nothing.

### Risks

- Financial data in email is only as private as the mailbox; totals-only
  content and opt-in defaults keep this proportionate.
- SMTP quota/reputation on the operator's own mail account (e.g. iCloud)
  if many households opt in — the durable queue's retry/dead-letter
  behavior already absorbs transient failures.
- Families span timezones; "previous month" must be computed in the
  family's timezone, which the report services already accept.

### Recommendation: **implement**

This is the one item where the flag is a legitimate rollout gate: the
plumbing exists, the scope is bounded to one handler plus an opt-in field,
and the flag can be flipped per instance once the owner is satisfied. It
should still ship opt-in and off by default.

---

## 3. Scheduled MeroShare sync (considered; no flag exists)

### Current state

Sync is manual: a member opens Settings → MeroShare and syncs each
connection, which calls `syncMeroShareConnection(exec, actor, connectionId)`
in `src/server/domain/meroshare.ts`. Credentials (CDSC username/password)
are stored AES-256-GCM encrypted and decrypted only for the sync; CDSC
authentication is a fresh password login per sync — there is no refresh
token. Key rotation for the stored credentials now exists
(`npm run meroshare:rotate-key`).

### What implementing it would involve

- **An actor-less sync path.** The current entry point requires an `Actor`
  (family + user). A scheduler must synthesize the actor from the
  connection's stored `familyId`/`userId`, or the domain function needs a
  system variant — with care that audit events still attribute the sync.
- **Scheduling + failure isolation**: a cron definition that selects
  connections by `lastSyncedAt` staleness and syncs them one by one,
  isolating per-connection failures the way `runRecurringPost` /
  `runBalanceMaintenance` isolate per-series/per-account failures and
  surface an aggregate failure to the queue.
- **Opt-in per connection** (a new column, default off): unattended use of
  a stored broker password should be an explicit choice per household.
- **Failure surfacing**: `lastSyncedAt` exists, but there is no
  last-sync-status/error field. Without one, a broken connection fails
  silently forever. Add status tracking plus a diagnostics/debug-log entry,
  and stop retrying on authentication failure (a changed DP password would
  otherwise produce a failed login every interval indefinitely).

### Risks

- **CDSC rate limits and lockouts.** The client already maps HTTP 429 to a
  "temporarily unavailable" error, but nothing backs off across runs, and
  repeated password logins from a server IP may trip DP-side fraud controls
  or lock the account — locking the user out of MeroShare itself.
- **Credential blast radius.** Automation means the server logs in as the
  user unattended; combined with a database leak that is worse than the
  manual flow, even with encryption at rest. (Rotation tooling now exists,
  which helps incident response but does not remove the risk.)
- **Low marginal value today.** Portfolio values move on NEPSE trading
  days; a manual sync when the user opens the app captures most of the
  value with none of the above risk.

### Recommendation: **defer**

Manual sync is adequate for a self-hosted, single-household-first product.
Revisit only with the opt-in column, failure surfacing, and
auth-failure backoff designed in from the start — and ideally after CDSC
behavior under repeated automated logins is understood. Do not add a flag
for it in the meantime; per item 1, an unwired toggle is worse than none.

---

## Summary

| Item                      | State today                        | Recommendation |
| ------------------------- | ---------------------------------- | -------------- |
| `net_worth_projections`   | Flag with no consumer              | Remove the flag |
| `monthly_digest_email`    | Flag with no consumer; infra ready | Implement (opt-in, flag-gated) |
| Scheduled MeroShare sync  | Manual sync only                   | Defer |
