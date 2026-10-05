# Meridian Operational Runbooks

## 1. Database Backup & Restore

### Backup Procedure (PostgreSQL Dump)

Meridian stores all core financial records, double-entry ledger transactions, audits, and sessions in PostgreSQL.

To create a consistent snapshot of the application database:

```bash
# In Docker environments:
docker compose exec db pg_dump -U meridian -d meridian -F c -b -v -f /var/lib/postgresql/data/backup_$(date +%Y%m%d_%H%M%S).dump

# On host / native PostgreSQL:
pg_dump -U meridian -h 127.0.0.1 -p 5432 -d meridian -F c -b -v -f backup_$(date +%Y%m%d_%H%M%S).dump
```

**Recommended Backup Policy:**

- Run automated hourly WAL archiving or daily dumps via cron or systemd timer.
- Encrypt backups at rest (`gpg -c backup.dump` or age/age-keygen) before offsite sync.
- Retention: Keep 7 daily, 4 weekly, 12 monthly snapshots.

### Restore Procedure

Before restoring, stop the `web` and `worker` services to avoid concurrent mutations:

```bash
docker compose stop web worker

# Drop existing connection and restore snapshot into empty database:
docker compose exec -T db dropdb -U meridian --if-exists meridian
docker compose exec -T db createdb -U meridian meridian
docker compose exec -T db pg_restore -U meridian -d meridian -v < backup.dump

# Run migrations to bring restored database to match current codebase:
docker compose run --rm web npm run db:migrate

# Start web and worker services:
docker compose start web worker
```

### JSON Family Data Export & Recovery

Users and administrators can also download household data snapshots:

- Path: **Settings > Household Data > Export**
- Endpoint: `GET /api/export`
- Formats: Meridian JSON v1 (sanitized, excludes third-party credentials and password hashes).

---

## 2. Worker & Queue Monitoring

### Health Endpoint

The health endpoint reports status at `/api/health`:

- **HTTP 200 `status: "ok"`**: Database reachable, all migrations applied, mail transport configured, zero dead-letter jobs.
- **HTTP 200 `status: "degraded"`**: Database reachable, but dead jobs exist in the queue or mailer is improperly configured.
- **HTTP 503 `status: "degraded"`**: Unapplied database migrations pending.
- **HTTP 503 `status: "error"`**: Database connection failed.

Example response:

```json
{
  "status": "ok",
  "db": true,
  "migrations": "current",
  "queue": {
    "pending": 0,
    "running": 0,
    "completed": 45,
    "dead": 0
  },
  "mail": {
    "transport": "smtp",
    "ready": true
  }
}
```

### Dead-Letter Job Remediation

When a background job exceeds its maximum attempts (default 5), it enters the `dead` status and logs to `debug_logs`:

1. Check dead jobs in database:
   ```sql
   SELECT id, queue, attempts, last_error, created_at FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC;
   ```
2. Replay a specific dead job:
   ```sql
   UPDATE jobs SET status = 'pending', attempts = 0, run_after = now(), updated_at = now() WHERE id = '<job-id>';
   ```

---

## 3. Deployment Hardening & Security Defaults

1. **Port Binding**:
   - PostgreSQL port `5432` is bound strictly to `127.0.0.1` by default in `docker-compose.yml`.
   - Web application port `3000` is bound to `127.0.0.1`. Use a reverse proxy (Nginx, Caddy, Cloudflare Tunnel) with HTTPS termination.
2. **Reverse Proxy Configuration**:
   - When running behind a reverse proxy (e.g. Caddy, Nginx), set `TRUST_PROXY=true` in environment variables so client IP addresses for rate limiting are parsed safely from `X-Forwarded-For`.
3. **Mail Configuration**:
   - Set `MAIL_TRANSPORT=smtp`, `SMTP_URL=smtp://user:pass@smtp.host:587`, and `MAIL_FROM=no-reply@yourdomain` in production, alongside `NODE_ENV=production` and an HTTPS `APP_URL`.
   - The mailer fails closed: console transport is refused in production, and SMTP without `SMTP_URL` (or without `MAIL_FROM` in production) refuses to start. `/api/health` reports `mail.ready=false` and an overall `degraded` status when misconfigured.
   - Before cutover, verify real delivery end-to-end: send sign-up verification, password reset, family invitation, and email-change messages to a real recipient inbox, and confirm SPF/DKIM/DMARC pass for the sending domain.

---

## 4. Platform Administrator Management

Platform super-admin is never granted through signup, email verification, or
family invitations (S13). It is granted only by an operator with database
access:

```bash
# Grant. Requires the account to have proven inbox ownership (a previously
# clicked email-verification or password-reset link). If ownership is
# unproven, a one-time verification link is issued instead — nothing is granted.
npm run admin:promote -- ops@example.com

# Re-run the same command after the account owner opens the link.
npm run admin:promote -- ops@example.com

# Revoke.
npm run admin:promote -- ops@example.com --demote
```

Every grant and revocation writes an audit event
(`user.platform_admin_granted` / `user.platform_admin_revoked`).

---

## 5. Member Removal & Restoration

Removing a family member deactivates the account (`users.removed_at`) instead
of deleting it (S14):

- The member's sessions, auth tokens, and account shares are revoked
  immediately; shares on accounts they own are revoked as well.
- Accounts they own — including private accounts — stay preserved with all
  ledger entries, balances, transfers, and audit history under the deactivated
  owner. Nobody gains access to the archived private accounts.
- Removed members cannot sign in, be promoted to platform admin, or accept
  invitations while removed.
- To restore a removed member: send them a new invitation
  (Settings > Members). Accepting the emailed link reactivates the account
  and lets them set a new password.
- Family admins cannot remove a platform super-admin; demote that account
  first (see section 4).

---

## 6. Cloudflare operations (production)

Production runs OpenNext on a Cloudflare Worker with **all data in one
SQLite-backed Durable Object** (`meridian-v1`, class `MeridianDatabase`).
The PostgreSQL procedures in section 1 do not apply to it. Everything here
stays on Free plans. See also [deployment notes](./cloudflare-deployment.md).

### Operator access

Set the Worker secret once (rotate freely, no data consequences):

```bash
openssl rand -base64 32            # generate
npx wrangler secret put MERIDIAN_OPS_TOKEN
```

With the secret set, requests to `https://meridian.arunshrestha.info.np/__meridian/ops/*`
carrying the header `x-meridian-ops-token: <secret>` reach the operator
endpoints inside the Durable Object. Without the exact token, every
`/__meridian/*` path is the stock 404; the object re-validates the token
independently. Cloudflare Access still sits in front of these paths, so also
create an Access service token with an Allow rule (see the uptime section
below) and export it as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`
before running the CLI. Drive everything through `node bin/cloud-ops.mjs`
(no npm script entry needed):

```bash
node bin/cloud-ops.mjs status
node bin/cloud-ops.mjs bookmark --time 2026-10-04T12:00:00Z
node bin/cloud-ops.mjs export --out meridian-backup.json
node bin/cloud-ops.mjs restore --time 2026-10-04T12:00:00Z          # dry run only
node bin/cloud-ops.mjs restore --time 2026-10-04T12:00:00Z --yes    # restores
```

### Deploy and rollback

Deploy with `npm run cf:deploy`; Worker secrets persist across deploys.
`npx wrangler rollback` (optionally with a version id) instantly reverts the
Worker code. **Limits:** rollback touches code only — the Durable Object
database keeps its data and already-applied migrations. Cloud migrations are
forward-only (no down-scripts), so after rolling back to older code, newer
schema may remain in the database. If that breaks the older code, follow with
a PITR restore to a bookmark from before the offending deploy.

### Point-in-time recovery (PITR)

SQLite-backed Durable Objects retain 30 days of change history, so the object
can be restored to any point in the last 30 days ([Cloudflare
docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
No paid service is involved. PITR is **not available in local preview**
(miniflare keeps no change log; the endpoints report 501 there).

Restore flow (`bin/cloud-ops.mjs restore`):

1. Dry run resolves the target bookmark for a timestamp (or accepts an exact
   `--bookmark`) and reports `undoBookmark` (the current state).
2. With `--yes` the script records the undo bookmark to `logs/cloud-ops.jsonl`
   **before** restoring — the restore wipes everything written after the
   target bookmark, including in-database audit rows.
3. The object writes an `ops.restore_started` audit event, hands the target
   bookmark to storage, and aborts its session; it restarts at the bookmark.
4. The script waits for the object to answer again, then writes
   `ops.restore_completed` into the restored database.
5. Undo: `node bin/cloud-ops.mjs restore --bookmark <undoBookmark> --yes`
   (also within 30 days).

**Restore drill** (run once before trusting PITR, then periodically): take an
export, note the time, add a visible test transaction in the UI, restore to
just before it, confirm it is gone, restore back with the undo bookmark,
confirm it is back, and check `/api/health`. Local tests prove the
orchestration; only this live drill proves an actual storage-relay restore.

### Off-site logical backup (free)

`node bin/cloud-ops.mjs export` streams every application table as JSON
(`meridian-ops-export` v1). Credential columns are ciphertext; the export
contains no Worker secrets. Encrypt and store offline, then delete the
plaintext: `gpg --symmetric --output b.json.gpg b.json`. Suggested retention:
7 daily, 4 weekly, 12 monthly, scheduled from any machine holding the ops
token. PITR only covers 30 days; exports are the long-horizon record.
**Note:** import-from-export is not implemented — exports are an offline
record and partial manual-recovery aid, not a one-command restore.

### Health and uptime monitoring

`/api/health` reports `db`, `migrations`, `queue` (pending/running/completed/
dead) and `cron.lastTickAt` — the last successful five-minute cron tick —
plus mail configuration. HTTP 503 means failing DB, pending migrations.
Cloudflare Access protects the whole hostname, so a plain external checker
only sees the Access login. For a real check on a free plan: create an Access
**service token** (Zero Trust → Service tokens), add an Allow rule for it to
the Meridian Access application, and point a free uptime monitor
(e.g. Better Stack or UptimeRobot) at `/api/health` sending the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. Alert on non-200;
to catch a stalled cron, use a keyword-capable monitor on `lastTickAt` or
check `node bin/cloud-ops.mjs status` when investigating.

### Secret rotation

- `MERIDIAN_OPS_TOKEN`: rotate freely (`wrangler secret put ...`), then
  update operator machines. No data consequences.
- `MERO_SHARE_ENCRYPTION_KEY`: **do not rotate casually.** Replacing it makes
  every stored MeroShare credential undecryptable; affected users must
  re-enter credentials (there is no re-encryption path). If key compromise
  forces rotation, expect every household using MeroShare to reconnect.
- Access/Google OAuth secrets live in the Cloudflare/Google consoles, not in
  the Worker.

### Incident response

1. Look at `/api/health` and `node bin/cloud-ops.mjs status` (queue depth,
   last tick, table counts, current bookmark).
2. Bad code: `npx wrangler rollback` (code only).
3. Bad data: `bin/cloud-ops.mjs restore` to just before the incident
   (dry-run first; undo bookmark is logged).
4. Loss beyond 30 days: latest encrypted export is the only record; recovery
   is manual.
5. Write down what happened; `audit_events` keeps the `ops.restore_*` trail
   for every restore performed.
