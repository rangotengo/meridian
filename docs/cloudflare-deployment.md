# Cloudflare deployment

Deployed on 2026-09-09 at https://meridian.arunshrestha.info.np.
The operator confirmed Workers Free and both Access login methods. No paid
services were enabled. Production starts with an empty database; local financial
data was not copied or changed.

## Runtime and storage

Next.js runs through OpenNext on Workers. The custom Worker forwards application
requests into one SQLite-backed Durable Object, preserving interactive ledger
transactions across awaited queries. A transaction mutex prevents concurrent
reads from observing uncommitted writes. Local deployments retain PostgreSQL.
Cloud migrations in `db/cloud-migrations` apply atomically when the object starts;
PostgreSQL migrations remain separate. Do not run the PostgreSQL CLI against cloud storage.

A five-minute Cron Trigger processes bounded batches of queued work, with retries,
stale-job recovery and deduplication. The internal scheduler endpoint is not public.
Workers development URLs and preview URLs are disabled for production.
No R2, paid image service, external database or AI provider is configured.

Cloudflare Access protects the entire hostname and Meridian validates its signed
assertion. Both Google and email-code options were verified on the live login
page. See [Access configuration](./cloudflare-access.md). Access Free has a
50-user limit; each new user creates a private household unless accepting an invitation.

Invitations use explicit copy-and-share links (`MAIL_TRANSPORT=manual`).
Access delivers login codes. Meridian does not claim to send invitation emails:
Cloudflare free email delivery to arbitrary unverified recipients is unavailable.

## Deploy again

Use Node 22 or later and an authenticated Wrangler session for the configured
account. Keep Workers and Access on Free; exceeding included allowances may
interrupt service. Review [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

```sh
npm ci
npm run test:cloud
npm run typecheck
npm run lint
npm run cf:deploy
```

The adapter uses a webpack build because traced-file copying from Turbopack
fails on this Windows installation. `npm run cf:preview` runs the bundled Worker
locally. Put local cloud-mode variables in ignored `.dev.vars` so Wrangler does
not inherit PostgreSQL settings from `.env.local`.

`MERO_SHARE_ENCRYPTION_KEY` is a production Worker secret, independently generated
for this empty database. Preserve it: replacing it makes stored MeroShare
credentials unreadable. For initial setup, securely pipe a base64-encoded random
32-byte key into `wrangler secret put MERO_SHARE_ENCRYPTION_KEY`; never commit it.
Normal deployments preserve the existing secret.

## Backups, restore and monitoring

Since 2026-10-05 production has an operator-only maintenance surface gated by
the `MERIDIAN_OPS_TOKEN` Worker secret (`wrangler secret put MERIDIAN_OPS_TOKEN`,
rotatable freely). Requests to `/__meridian/ops/*` carrying the
`x-meridian-ops-token` header reach the Durable Object; without the exact token
those paths keep the stock 404. The `node bin/cloud-ops.mjs` CLI drives:

- **Point-in-time recovery**: 30-day bookmarks (`status`, `bookmark` dry-run,
  `restore` with offline undo-bookmark log and `ops.restore_*` audit events).
  PITR needs Cloudflare's storage relay, so local preview answers 501 there.
- **Logical snapshot export** of every application table for off-site,
  operator-encrypted backups (ciphertext credential columns only, no secrets).
- `/api/health` additionally reports `cron.lastTickAt`, the last successful
  five-minute cron tick.

Full procedures, rollback limits, secret rotation and incident response live in
[runbook section 6](./RUNBOOKS.md#6-cloudflare-operations-production), including
a free uptime check design (Access service token + free monitor).

## Verification

- Production deployment and custom domain binding succeeded; HTTPS redirects to
  Access with the configured application audience and both login options.
- Staging on Cloudflare returned healthy database/migrations and rejected
  unauthenticated exports and public scheduler access.
- All 202 automated tests passed, including seven actual workerd SQLite tests
  covering rollback, concurrent isolation, exact money guards, ledger flows,
  transfers, reports, recurring work, invitations, imports and encrypted MeroShare
  storage with a mocked upstream. Lint and the production build passed.
- Interactive provider authentication, first household creation and a real
  MeroShare connection still need a signed-in user. Automated tests do not prove
  these external-provider flows or sustained production capacity.
