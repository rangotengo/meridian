# Browser acceptance tests (Playwright)

End-to-end browser coverage for the flows the unit/integration suites cannot
see: real sign-in, invitation acceptance, permission-dependent forms,
transfers, splits, mobile layout, and accessibility smoke checks.

## Running

```bash
npm run test:e2e:install   # once: download the Chromium build Playwright drives
npm run test:e2e
```

`npm run test:e2e` will:

1. Build the app (`next build`) and serve it with `next start` on
   http://localhost:3100 (override with `E2E_PORT`).
2. Run `e2e/global-setup.ts`, which executes `e2e/seed.ts` under `tsx`:
   migrate the E2E database, wipe it, and seed a household through the
   app's own domain functions (see below).
3. Run the specs serially in a single worker — they share the seeded
   household and some of them mutate it.

## Test database

The suite never touches the application database. By default it uses a
dedicated PostgreSQL database `meridian_test_e2e` on the local embedded
test server (127.0.0.1:55439, user `review_admin`). Override with
`E2E_DATABASE_URL`. The database name must satisfy the repo's test-database
guard (it must contain "test") because the seed reuses `tests/helpers.ts`,
including its `truncateAll`.

## What the seed creates

- **Family admin** — `admin@e2e.local` (password in `e2e/fixtures.ts`),
  registered via `registerUserWithFamily` (through `tests/helpers`).
- **Accounts** — "E2E Checking" and "E2E Savings" (USD), plus one expense
  entry, "E2E Groceries". Both accounts are personally owned by the admin
  (`joint: false`): ownerless accounts grant every family member full
  control by design, so ownership is what makes the members' account
  shares (below) determine their access levels.
- **Read-write member** (`rw@e2e.local`) and **read-only member**
  (`ro@e2e.local`) — both join through real family invitations
  (`createInvitation` + `acceptInvitationWithNewAccount`), then receive
  `read_write` / `read_only` account shares on E2E Checking.
- **One unconsumed invitation** for `invitee@e2e.local`; its raw token is
  handed to `invitations.spec.ts`, which drives `/invitations/<token>`
  directly (email delivery is out of scope for the browser suite).
- **Storage states** — real sessions minted with `createSession` and
  written to `e2e/.auth/{admin,rw,ro}.json` (gitignored), so specs start
  signed in without burning the login rate limit (5 attempts per
  15 minutes per email+IP). Only `auth.spec.ts` drives the sign-in form.

Ids, emails, and the invitation token are written to `e2e/test-data.json`
(gitignored) and read by the specs through `e2e/fixtures.ts`.

## Spec map

| File                  | Covers                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`        | Login success reaches the dashboard; wrong password shows an error.                                            |
| `invitations.spec.ts` | Invitation link opens the acceptance page; joining signs the member in.                                        |
| `permissions.spec.ts` | Read-only member: edit controls disabled/absent. Read-write: annotate only, core fields locked, save persists. |
| `transfers.spec.ts`   | Create a transfer; both legs listed; a leg shows its linked partner.                                           |
| `splits.spec.ts`      | Split a transaction 60/40; split lines and amounts shown, total exact.                                         |
| `mobile.spec.ts`      | Dashboard + transactions at 390px wide, no horizontal overflow (mobile project).                               |
| `a11y.spec.ts`        | axe-core: no critical violations on sign-in and dashboard.                                                     |

## Notes

- The app is served from the production build, not `next dev`, so the
  suite exercises the same artifact shape that gets deployed.
- Traces and screenshots are kept on failure (`test-results/`).
