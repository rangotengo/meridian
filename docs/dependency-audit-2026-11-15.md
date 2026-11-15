# Dependency audit response — 2026-11-15

## Background

A fresh `npm audit` on the owner's machine reported **36 findings: 3 critical, 12 high,
20 moderate, 1 low**, spanning runtime dependencies and development/build tooling. Audit
findings alone do not establish that the production deployment is exploitable; this pass
updates everything that can be updated safely and documents what remains and why.

## Method and caveat

During initial implementation the managed registry denied the audit endpoint, so updates
were driven by lockfile and registry freshness rather than individual advisories.

The merge review subsequently ran a successful `npm audit` on the combined changes.
The initial update left 17 findings (3 high, 12 moderate, 2 low). All high findings came
from the direct Miniflare alpha pin and its `sharp` / `undici` dependencies. The review
aligned that pin with `miniflare@5.20261113.0-beta`, already used by Wrangler, and verified
the Cloudflare SQLite suite again (19/19).

The resulting audit reports **14 findings: 0 critical, 0 high, 12 moderate, 2 low**.
`npm audit --omit=dev` reports **3 moderate findings, no high or critical findings**,
through OpenNext's glob/minimatch build tooling. Next's own `sharp` is patched at 0.35.5.
Remaining full-tree findings involve glob/minimatch, typescript-eslint, and shadcn's
registry/deepmerge tooling. npm's suggested fixes include incompatible downgrades;
they were not applied blindly. These counts are package-level findings, not a claim
that every advisory is reachable in the deployed application.

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

| Package    | Current           | Latest         | Reason                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typescript | 5.9.3             | 7.0.2          | **Blocked, not skipped.** Installation fails with an npm peer conflict: `typescript-eslint@8.72.2` requires `typescript >=4.8.4 <6.1.0`. Revisit when typescript-eslint ships a release whose peer range admits TypeScript 7 (or when the repo is ready to change its lint toolchain). Dev-only; no production exposure in the meantime. |
| miniflare  | 5.20261113.0-beta | 4.x stable tag | The direct preview-tooling pin was advanced to the newer 5.x beta already used by Wrangler to remove the alpha's high-severity transitive findings. The stable registry tag remains an older major.                                                                                                                                      |

Other dependency updates remain as described above; registry tags alone do not establish advisory remediation.

## Recommended follow-up

1. Track patched upstream versions for the remaining moderate/low findings and re-run
   both audit modes after future lockfile changes; the current counts are recorded above.
2. When typescript-eslint supports TypeScript 7, retry that single bump with the same
   full-verification procedure.
