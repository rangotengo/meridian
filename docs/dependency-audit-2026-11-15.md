# Dependency audit response — 2026-11-15

## Background

A fresh `npm audit` on the owner's machine reported **36 findings: 3 critical, 12 high,
20 moderate, 1 low**, spanning runtime dependencies and development/build tooling. Audit
findings alone do not establish that the production deployment is exploitable; this pass
updates everything that can be updated safely and documents what remains and why.

## Method and caveat

The environment this work was done in cannot run `npm audit`: the registry policy denies
the audit endpoint (`POST /-/npm/v1/security/audits/quick` returns `policy_denied`), and
the owner's audit JSON was not available there. Updates were therefore driven by the
lockfile and registry metadata (`npm update`, then `npm outdated`), not by per-CVE
targeting. **The exact CVE-to-version mapping of the 36 findings could not be verified.**
The practical consequence: every package is now at the newest version its declared range
allows, plus eight major-version bumps that verified cleanly — which is the strongest
position reachable without audit data — but a follow-up `npm audit` on a machine with
audit access should confirm the finding count actually dropped, and any stragglers should
be triaged against this document.

## What was done

### 1. In-range update (`npm update`, commit `af94209`)

Lockfile-only refresh: 407 packages changed, tree shrank from 1191 to 1146 entries
(deduplication). `package.json` ranges were already wide enough; no range edits needed.
Direct dependencies that moved:

| Package                | From    | To      | Class   |
| ---------------------- | ------- | ------- | ------- |
| react / react-dom      | 19.2.8  | 19.3.1  | runtime |
| nodemailer             | 10.0.14 | 10.5.0  | runtime |
| zod                    | 4.4.3   | 4.6.7   | runtime |
| jose                   | 6.2.12  | 6.2.17  | runtime |
| drizzle-orm            | 0.45.2  | 0.45.4  | runtime |
| @opennextjs/cloudflare | 1.20.8  | 1.20.17 | runtime |
| @base-ui/react         | 1.8.0   | 1.9.0   | runtime |
| lucide-react           | 1.34.0  | 1.73.0  | runtime |
| motion                 | 13.2.0  | 13.5.1  | runtime |
| pg                     | 8.23.0  | 8.23.1  | runtime |
| tailwind-merge         | 3.6.0   | 3.7.0   | runtime |
| wrangler               | 4.147.0 | 4.162.0 | dev     |
| typescript-eslint      | 8.68.0  | 8.72.2  | dev     |
| prettier               | 3.9.6   | 3.10.1  | dev     |
| shadcn                 | 4.21.1  | 4.23.0  | dev     |
| tailwindcss            | 4.3.3   | 4.3.5   | dev     |
| @tailwindcss/postcss   | 4.3.3   | 4.3.5   | dev     |
| @types/node            | 24.13.3 | 24.19.2 | dev     |
| @types/react           | 19.2.18 | 19.3.0  | dev     |
| @types/react-dom       | 19.2.5  | 19.3.0  | dev     |
| tsx                    | 4.23.12 | 4.23.15 | dev     |

### 2. Major-version bumps (one commit each, fully verified after each)

| Package          | From    | To      | Class   | Commit    | Notes                                                                                                     |
| ---------------- | ------- | ------- | ------- | --------- | --------------------------------------------------------------------------------------------------------- |
| @types/node      | 24.19.2 | 26.6.6  | dev     | `5fd3ed2` | Type definitions only.                                                                                    |
| vitest           | 3.2.7   | 5.1.0   | dev     | `7f94470` | No config changes needed.                                                                                 |
| eslint           | 9.39.5  | 10.15.0 | dev     | `bef5ef2` | eslint-config-next 16.4.6 already compatible; also clears the "eslint 9 no longer supported" deprecation. |
| dotenv           | 16.6.1  | 18.0.10 | runtime | `37565a7` | Used by scripts/test setup; API unchanged for this usage.                                                 |
| pino             | 9.14.0  | 10.4.0  | runtime | `7708ca7` | Logger construction/call sites unchanged.                                                                 |
| motion           | 13.5.1  | 14.14.0 | runtime | `6201946` | Used surface (`motion`, `AnimatePresence`, `useReducedMotion`) unchanged.                                 |
| react-day-picker | 9.14.0  | 10.0.2  | runtime | `4d7bf1a` | One adaptation: classNames key `table` renamed to `month_grid` in `src/components/ui/calendar.tsx`.       |
| postgres         | 3.4.9   | 4.1.1   | test    | `e7f5512` | See classification note below.                                                                            |

Every kept bump passed the full verification suite at its own commit: typecheck, lint,
and format check clean; `npm test` 289/289 (PostgreSQL); `npm run test:cloud` 19/19;
`npm run build:next` succeeds.

## Exposure assessment

**Runtime** packages ship in the production server/bundle and are the ones whose
vulnerabilities could be reachable in deployment. All runtime direct dependencies are now
at their newest in-range versions, and four runtime majors (dotenv, pino, motion,
react-day-picker) were additionally taken. The production database driver is `pg`
(8.23.1, current) via `drizzle-orm/node-postgres`.

**Classification notes:**

- `postgres` (postgres.js) is declared under `dependencies` but is only imported by the
  test harness (`tests/helpers.ts`, `tests/setup/global.ts`). It has no production
  runtime exposure; it was still bumped to 4.1.1 since the test suite exercises it
  directly. Consider moving it to `devDependencies` in a future cleanup.
- `tailwindcss` / `@tailwindcss/postcss` are dev dependencies that run at build time and
  shape shipped CSS, but they execute no code in production.
- Everything else marked dev (eslint, vitest, typescript, @types/\*, prettier, shadcn,
  wrangler, tsx, miniflare, typescript-eslint) runs only on developer/CI machines. Findings
  there affect the build environment, not the deployed app.

## What remains outdated, and why

| Package    | Current            | Latest | Reason                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typescript | 5.9.3              | 7.0.2  | **Blocked, not skipped.** Installation fails with an npm peer conflict: `typescript-eslint@8.72.2` requires `typescript >=4.8.4 <6.1.0`. Revisit when typescript-eslint ships a release whose peer range admits TypeScript 7 (or when the repo is ready to change its lint toolchain). Dev-only; no production exposure in the meantime. |
| miniflare  | 5.20261001.0-alpha | 4.x    | **Deliberate pin, not behind.** The repo pins a 5.x prerelease (used by the OpenNext/Cloudflare test path) that is ahead of the latest stable 4.x line; "latest" in registry terms is a downgrade. Leave until a stable 5.x exists. Dev-only.                                                                                            |

No other direct dependency is behind its newest release as of 2026-11-15.

## Recommended follow-up

1. Run `npm audit` where the audit endpoint is reachable and confirm the 36 findings are
   resolved or map to the two documented exceptions above.
2. When typescript-eslint supports TypeScript 7, retry that single bump with the same
   full-verification procedure.
