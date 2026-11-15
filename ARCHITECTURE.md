# Architecture

## Dependency direction

```
app (pages, server actions)  →  domain services  →  db (drizzle + SQL)
        ↑                            ↑
   auth context / policy       queue · observability · flags
```

The browser never owns financial state. Pages render from services; mutations run through
server actions that call the same services. Services enforce authorization, currency, and
lifecycle rules; database constraints are the last line of defense.

## Module map

| Path                        | Responsibility                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/`                  | Money, dates, crypto, errors, logging, env validation, i18n messages                                                                            |
| `src/server/db/`            | Pool/client, drizzle schema, reviewed-SQL migration runner                                                                                      |
| `src/server/auth/`          | Session cookie → `Actor` resolution per request                                                                                                 |
| `src/server/authorization/` | Account access levels and family/platform role assertions                                                                                       |
| `src/server/domain/`        | Business rules: accounts, entries, transfers, splits, valuations, balances, reports, FX, exports, users/families, family + instance invitations |
| `src/server/security/`      | Password hashing, session store, auth tokens, rate limiting, mailer                                                                             |
| `src/server/queue/`         | Durable job queue, cron scheduler, worker loop contracts                                                                                        |
| `src/app/(auth)/`           | Public identity routes                                                                                                                          |
| `src/app/(app)/`            | Authenticated product surface (dashboard, accounts, transactions, reports, settings)                                                            |
| `src/app/admin/`            | Super-admin operations console                                                                                                                  |
| `src/worker/`               | Standalone job process                                                                                                                          |

## Data model highlights

- **Family** is the tenant boundary. Every query path filters through it; cross-family access
  is denied at service level with negative tests.
- **Registration** is operator-gated: `REGISTRATION_OPEN=false` closes public sign-up, after
  which new households arrive only by **instance invitation** (issued by a platform
  super-admin; acceptance creates the family and its admin). **Family invitations** are a
  separate flow: a family admin adds a member to an existing family. `REQUIRE_EMAIL_VERIFICATION`
  controls whether new accounts must verify their email before access.
- **Account** has a type (`depository`, `credit_card`, `other_asset`, `other_liability`),
  lifecycle status, optional owner, and report inclusion flag.
  - Owner set → other members need an explicit share (`full_control` / `read_write` /
    `read_only`). Owner null → joint account, full control for all family members.
- **Entry** is the ledger row: date, signed `amount_minor`, currency, name, typed entryable
  (`transaction` or `valuation`), optional parent link for splits, and optional external id
  with a partial unique index for import-safe idempotency.
- **Sign convention** matches the source project: outflow entries are positive, inflow
  negative. Display balance = opening anchor − Σ(entry amounts). UI negates for presentation.
- **Transfer** joins exactly two transaction legs in different accounts of one family with
  opposing amounts within ±4 days; creation/removal is atomic and retry-safe.
- **Split** children must sum to the parent amount and inherit its date/account/currency;
  balance math counts leaves only (`parent_entry_id IS NULL`).
- **Balances** are materialized daily snapshots recomputed on writes (forward from earliest
  affected date) and nightly by the worker. Valuation-driven accounts track latest valuation.
- **Exchange rates** are dated pairs; conversions use latest rate ≤ date with inverse fallback;
  missing rates exclude amounts from converted totals and raise a support-visible diagnostic.

## Queue semantics

Jobs live in a `jobs` table with attempts/max/backoff/dedupe/dead-letter states. The worker
claims batches with `FOR UPDATE SKIP LOCKED`, recovers stale locks, runs cron schedules from
`cron_schedules`, and records failures both in-row and in `debug_log_entries`. Email delivery,
nightly balance maintenance, and retention cleanup ship as the initial job set.

Two deployment shapes run the same codebase: self-hosted on PostgreSQL (web app plus a
standalone worker process; the Docker image picks its role via `APP_ROLE` in
`docker-entrypoint.sh`), and Cloudflare Workers backed by SQLite in Durable Objects
(`DATABASE_BACKEND=cloud-sqlite`), with schema and migrations maintained per backend.

## Observability

Structured pino logs with action names/timings, redaction of sensitive keys, an audit trail
(`audit_events`) for auth/sharing/ledger/lifecycle events, and a super-admin diagnostics page
surfacing `debug_log_entries` plus queue health.

## Deliberate exclusions

See DECISIONS.md for the original launch scope. Budgets, recurring transactions, MeroShare
portfolio sync, an AI chat surface, Sure data import, and the Shortcuts API (`/api/v1`) have
shipped since; bank aggregation providers, shared expenses, MFA/passkeys, and a general
public API remain out of scope.
