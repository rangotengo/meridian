# Backup & Recovery

Meridian has two complementary data-protection layers:

| Layer                          | Scope                             | Where it lives                                             | Restore path                                                          |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| **Scheduled instance backup**  | The whole instance (every family) | Nightly worker job → encrypted archive in `BACKUP_DIR`     | `npm run backup:restore` into a fresh, empty database                 |
| **Household export / restore** | One family                        | Settings → Your data → "Export everything" (JSON download) | Settings → Your data → "Restore a Meridian export" in an empty family |

The older manual `pg_dump`/`pg_restore` procedure in `docs/RUNBOOKS.md` still
works and remains a valid last resort; the scheduled backup below is the
automated path and needs no database tooling on the host.

## Scheduled encrypted backups

### Configuration

Set on **both** the web and worker apps (the worker runs the job; the web app
does not need them, but keeping the configuration identical avoids surprises):

| Variable                | Meaning                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY` | 32-byte key, base64. Generate with `openssl rand -base64 32`. **Store it outside the server** (password manager) — an archive is unreadable without it, and it is not stored in the database. |
| `BACKUP_DIR`            | Directory the worker writes archives to. Use a path on a volume that is itself synced off-box (or accept that backups protect against data corruption, not host loss).                        |
| `BACKUP_RETENTION`      | How many of the newest archives to keep. Default `7`.                                                                                                                                         |

When either the key or the directory is unset, backups are disabled and the
nightly job completes as a no-op.

### What runs

The worker registers a `nightly-backup` cron (`47 2 * * *`) that enqueues a
`maintenance:backup` job. The job:

1. Builds a versioned instance export (JSON) of every data-bearing table —
   families, users (including password hashes), accounts, entries, transfers,
   budgets, recurring series, saved filters, MeroShare data, audit events, and
   materialized balances. Ephemeral state is excluded on purpose: sessions and
   auth tokens (everyone signs in again after a restore), rate-limit counters,
   the job queue, and cron schedules (recreated on worker boot).
2. Encrypts it with AES-256-GCM using `BACKUP_ENCRYPTION_KEY` (the same
   `v1.iv.tag.ciphertext` format as provider secrets) and writes
   `meridian-backup-<timestamp>.json.enc` into `BACKUP_DIR`.
3. Deletes all but the newest `BACKUP_RETENTION` archives in that directory.
4. Records an `instance.backup_created` audit event with the file name.

### Verifying backups are happening

- Check `BACKUP_DIR` for a fresh `meridian-backup-*.json.enc` each morning.
- Or check the instance audit log / admin job view for `maintenance:backup`
  completions and `instance.backup_created` events.
- A missing key or directory makes the job skip silently by design — if no
  files appear, check the configuration first.

## Recovery: restore an instance backup into a fresh instance

Use this after data corruption, a bad migration, or moving to a new host.
The restore **preserves all ids** and runs in a single transaction; it
refuses to run against a database that already contains families.

1. **Provision the fresh instance** the usual way (same Meridian version):
   empty PostgreSQL database, migrations applied (the app migrates on boot),
   web and worker **stopped** so nothing writes during the restore.
2. **Copy the archive** you want onto the host and make sure
   `BACKUP_ENCRYPTION_KEY` in the environment matches the key that created it.
3. **Run the restore** from the app directory (or the web container):

   ```bash
   DATABASE_URL=<fresh-instance-url> BACKUP_ENCRYPTION_KEY=<key> \
     npm run backup:restore -- /path/to/meridian-backup-<timestamp>.json.enc
   ```

   The command decrypts the archive, prints the export timestamp, refuses if
   the database is not empty, inserts every table in foreign-key order, and
   prints per-table row counts. Any failure rolls the whole restore back —
   the database stays empty and you can fix the cause and re-run.

4. **Start web and worker.**
5. **Verify the restore:**
   - `GET /api/health` returns `{"status":"ok","db":true,"migrations":"current", ...}`.
   - Sign in with a known account (passwords are in the backup; sessions are
     not, so everyone signs in fresh).
   - Spot-check balances: open two or three accounts and compare their current
     balances against the pre-incident instance or the household exports.
   - Open Reports for the current month and confirm totals look sane.
   - Confirm the worker log shows `worker.started` and the queue drains
     (recurring posting resumes on its normal schedule).
6. **Rotate if the incident involved compromise:** the archive contains
   password hashes and MeroShare credentials (encrypted in the database with
   `MERO_SHARE_ENCRYPTION_KEY`). If the backup key may have leaked, generate a
   new one, take a fresh backup, and delete archives made with the old key.

## Household export / restore (per family)

Independent of operator backups, a family admin can download a complete
household export (Settings → Your data). Format v2 includes budgets,
recurring definitions, and saved filters alongside accounts, entries,
transfers, categories, and tags; the importer also accepts v1 exports.

Restore semantics, deliberately the same as the Sure migration:

- Restores into the admin's **current family, only when it is empty** —
  a restore can never merge into or overwrite existing data.
- Everything applies in one transaction; any invalid reference rolls it all
  back and the family stays empty.
- Entities are recreated with **new ids**; all internal references are
  remapped, and account balances are recalculated from the restored ledger.
- People are never recreated (exports carry no credentials). Members, account
  owners, share grantees, and saved-filter owners are matched to existing
  family members **by email**; shares and saved filters for people who have
  not joined yet are skipped and reported in the import result.
- Family settings (name, currency, locale, timezone) are **not** overwritten.

Typical uses: moving a household between instances, recovering one family
without rolling back the whole instance, or seeding a test instance.

## Drill

Once per quarter (and after any change to backup code):

1. Copy the newest nightly archive off-box.
2. Restore it into a throwaway database with `npm run backup:restore`.
3. Boot the app against that database and run the verification steps above.
4. Record the drill date and outcome in your operations log.
