# Meridian

Self-hosted personal finance ledger. Know exactly where you stand.

Meridian is a Next.js implementation of the core personal-finance contract described in the
Sure clone plan: family-scoped accounts, a typed double-sided ledger with transfers and splits,
materialized daily balances, server-owned reporting, durable background jobs, and rigorous
authorization, a guarded Sure-data migration, direct CDSC MeroShare portfolio sync, and optional AI surfaces.

## Stack

| Concern    | Choice                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | Next.js (App Router) + React + TypeScript (strict)                                                                                 |
| Database   | PostgreSQL 16+ (self-hosted) or SQLite in Durable Objects (Cloudflare), via Drizzle ORM; reviewed SQL migrations for both backends |
| Auth       | In-house sessions (scrypt passwords, hashed opaque tokens, revocation)                                                             |
| Queue      | Database-backed worker process (`FOR UPDATE SKIP LOCKED`, retries, dead-letter, cron)                                              |
| Validation | Zod at action boundaries; domain invariants enforced in services                                                                   |
| UI         | Tailwind CSS v4 with semantic design tokens                                                                                        |
| Tests      | Vitest unit + integration against real Postgres, plus a Cloudflare-backend suite                                                   |

## Requirements

- Node.js 22+
- PostgreSQL 16+ (local, Homebrew service, or `docker compose up -d db`)

## Getting started

```bash
npm install
cp .env.example .env.local            # adjust DATABASE_URL / APP_URL if needed
npm run db:migrate                    # apply SQL migrations
SEED_DEMO=true npm run db:seed        # optional demo household
npm run dev                           # web app on http://localhost:3000
npm run worker                        # background jobs (separate terminal)
```

Or run the stack with Docker:

```bash
docker compose up --build
```

That starts Postgres, applies migrations, serves the web app on http://localhost:3000, and runs the worker. The stack runs with `NODE_ENV=production`, so real SMTP is required: set `MAIL_TRANSPORT=smtp`, `SMTP_URL`, and `MAIL_FROM` in the environment (for example via a `.env` file next to the compose file) before `docker compose up`.

The Docker image serves the web app by default; the worker is the same image with the role selected by environment: `docker-entrypoint.sh` runs the worker when `APP_ROLE=worker` (or when `worker` is passed as the container command). Hosting platforms whose start-command setting does not reach the entrypoint should set `APP_ROLE` instead.

The demo seed creates `demo@meridian.local` with password `meridian-demo-2026`
(override with `SEED_PASSWORD`).

Platform super-admin is never granted at signup, even for addresses listed in
`ADMIN_EMAILS`. Promote an operator with `npm run admin:promote -- you@example.com`
(`--demote` to revoke). The command requires the account to have proven inbox
ownership — a previously clicked email-verification or password-reset link — and
otherwise issues a one-time verification link instead. `ADMIN_EMAILS` only blocks
those addresses from being invited into a family.

Registration is operator-controlled. Public sign-up is open by default; set
`REGISTRATION_OPEN=false` to make the instance invite-only, in which case the
sign-up page explains that an invitation is required and the sign-up action
refuses. Two invitation types exist, and they are not interchangeable:

- **Family invitations** — a family admin invites someone to join _their_
  household as a member.
- **Instance invitations** — a platform super-admin invites an email address
  to create a _new_ household on the instance; accepting one creates the
  family with the invitee as its admin.

Set `REQUIRE_EMAIL_VERIFICATION=true` to require new accounts to verify their
email address before product access (verification mail is sent through the
configured mail transport).

## Scripts

| Command                                       | Purpose                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run dev`                                 | Web app in development mode                                                                         |
| `npm run build` / `npm start`                 | Production build and serve                                                                          |
| `npm run worker`                              | Background job runner (emails, maintenance crons)                                                   |
| `npm run db:migrate`                          | Apply pending migrations                                                                            |
| `npm run db:migrate:down`                     | Revert the most recent migration                                                                    |
| `npm test`                                    | Unit + integration tests (needs reachable Postgres)                                                 |
| `npm run test:cloud`                          | Cloudflare-backend (SQLite Durable Object) tests                                                    |
| `npm run meroshare:rotate-key`                | Re-encrypt stored MeroShare credentials to a new `MERO_SHARE_ENCRYPTION_KEY` (see docs/RUNBOOKS.md) |
| `npm run lint` / `typecheck` / `format:check` | CI checks                                                                                           |

## Environment

See `.env.example`. Everything is validated at boot (`src/lib/env.ts`) — the process refuses to
start with missing or malformed configuration. No secrets are ever committed or logged;
sensitive keys are redacted by the logging helper.

MeroShare is optional and requires `MERO_SHARE_ENCRYPTION_KEY` (a 32-byte base64 key) before a CDSC login can be saved. Meridian encrypts the username and password at rest, while the CDSC authorization header exists only for the in-flight sync. The key can be rotated without forcing households to reconnect: `npm run meroshare:rotate-key` re-encrypts stored credentials to a new key transactionally (see the secret-rotation runbook in docs/RUNBOOKS.md).

## Testing

```bash
TEST_DATABASE_URL=postgres://.../meridian_test npm test
```

The global setup recreates the test database from scratch each run (drop → create → migrate),
so suites are hermetic. Integration tests cover cross-family denial, the account-share
permission matrix, transfer atomicity/retry, split invariants, balance recalculation, FX
fallback behavior, queue retry/dead-letter/cron semantics, and audit trails.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — module layout, data model, sign conventions
- [DECISIONS.md](./DECISIONS.md) — scope decisions mapped from the source clone plan
- [SECURITY.md](./SECURITY.md) — threat model summary and controls
- [docs/upstream-sync-state.md](./docs/upstream-sync-state.md) — reviewed source baseline

## License notes

Meridian is an independent implementation inspired by behavioral documentation of the Sure
project (AGPLv3 fork of Maybe Finance). No source code was copied; verify attribution
obligations with legal counsel before distributing.
