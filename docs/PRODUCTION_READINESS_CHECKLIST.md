# Meridian production readiness checklist

Reviewed 2026-10-05. Production runs on Cloudflare Free plans: Next.js via
OpenNext on a Worker, **all data in one SQLite-backed Durable Object**
(`meridian-v1`), Cloudflare Access in front. Deployed 2026-09-09 at
https://meridian.arunshrestha.info.np with an empty database. PostgreSQL
remains the local/docker backend only.

## Done — architecture and code

- [x] Database strategy: SQLite-backed Durable Object, no external database,
      no paid services. Cloud migrations (`db/cloud-migrations`) apply
      atomically when the object starts.
- [x] Queue: five-minute Cron Trigger drives the in-object job queue with
      retries, stale-job recovery, dedupe and dead-letter handling.
- [x] Cloudflare compatibility: OpenNext deployment verified in staging and
      production (Server Actions, auth, exports, scheduler not public).
- [x] Auth: Cloudflare Access (Google + email codes) with full RS256
      assertion validation; AUD pinned; public/private signup modes; password
      flows disabled in Access mode.
- [x] Backup and restore paths (2026-10-05): 30-day point-in-time recovery
      via operator-only endpoints (`bin/cloud-ops.mjs`, gated by the
      `MERIDIAN_OPS_TOKEN` Worker secret) with dry-run, undo bookmark logged
      offline, and `ops.restore_*` audit events; free full-database logical
      export for off-site encrypted storage. Runbook: docs/RUNBOOKS.md §6.
- [x] Health endpoint: `/api/health` reports DB reachability, pending
      migrations, queue stats (pending/running/completed/dead),
      `cron.lastTickAt` (last successful five-minute tick) and mail config.
- [x] Earlier release blockers: safe admin promotion (S13), member removal
      (S14), currency-change safety (F13), fail-closed mailer configuration.

## Remaining operator tasks

- [ ] Live sign-in drill: complete Google and email-code login in production
      (login page verified 2026-09-09; interactive sign-in still untested).
- [ ] First real household: create the operator account/household in
      production and exercise one invitation link end to end.
- [ ] Live MeroShare: connect and sync one real connection in production.
- [ ] PITR restore drill in production (runbook §6): local tests prove the
      orchestration; only a live drill proves the storage-relay restore.
- [ ] Access **service token** for the Shortcuts API (mobile bank SMS
      endpoint) so iPhone Shortcuts can call it non-interactively; add an
      Allow rule for it in the Access application.
- [ ] Free external uptime monitor on `/api/health` using the service-token
      headers; alert on non-200 and on a stale `cron.lastTickAt`.
- [ ] Schedule off-site encrypted exports (any machine with the ops token;
      suggested 7 daily / 4 weekly / 12 monthly).
- [ ] Browser E2E against a production-shaped environment: signup,
      login/logout, invitations, member roles, private accounts, transfers,
      splits, reports, exports/imports, recurring entries, MeroShare; plus
      mobile layout, accessibility and large-export checks before wider use.

## Accepted risks and limits

- Import-from-export restore is not implemented; PITR (30 days) is the
  primary restore path and exports are the long-horizon offline record.
- `MERO_SHARE_ENCRYPTION_KEY` rotation invalidates all stored MeroShare
  credentials (no re-encryption path).
- `wrangler rollback` reverts Worker code only; cloud migrations are
  forward-only, so pair a rollback with a PITR restore when schema changed.
- Free-plan ceilings (Durable Objects: 5 GB storage, 100k requests/day,
  100k rows written/day) are ample for household scale; re-review before
  admitting many households.

## Release gate

Public scale-up only after the operator tasks above are done, a live restore
drill has succeeded, CI is green, and the browser E2E suite passes against
the deployed environment.
