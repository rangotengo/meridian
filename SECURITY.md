# Security

## Identity and sessions

- Passwords: scrypt (N=16384, r=8, p=1) with per-user salt; parameters stored in the hash
  string for future upgrades. Policy: ≥10 chars with letters and digits.
- Sessions: 256-bit opaque tokens; only SHA-256 hashes are persisted. Cookies are httpOnly,
  SameSite=Lax, Secure in production, 30-day sliding expiry. Revocation is immediate.
- Email verification is enforced before product access when the operator sets
  `REQUIRE_EMAIL_VERIFICATION=true` (recommended for any instance with more than one
  household); password reset proves inbox control and marks accounts verified.
  Reset/verification tokens are single-use, hashed, and expiring.
- Public registration can be closed with `REGISTRATION_OPEN=false`. New households then
  arrive only via super-admin instance invitations, and new members only via family-admin
  invitations; the two invitation types are enforced by separate domain services.
- Rate limits (DB-backed): login per email+IP 5/15min, password reset 5/hour, verification
  resend 3/hour.

## Authorization

- Family predicate enforced in every service query path; account access resolves to
  full_control / read_write / read_only via ownership or explicit shares. Platform
  super-admin grants operations access only — never financial data access.
- Field-level gating: `read_write` may annotate (category/tags/notes/merchant) but cannot
  alter amounts, dates, names, splits, transfers, or deletion.

## Money integrity

- Amounts are bigint minor units guarded to safe-integer range; no floats touch persistence.
- Transfers validate family, distinct accounts, opposing equal amounts, ±4-day window, and
  are idempotent under retry (same pair returns the existing transfer).
- Balance snapshots are recomputed deterministically from the ledger; reports reconcile
  against fixtures in tests.

## Application hardening

- Security headers: frame-deny, nosniff, strict referrer policy, restricted permissions,
  COOP same-origin (`next.config.ts`).
- CSRF: Next.js server actions verify Origin/Host on every mutation; cookies SameSite=Lax;
  export download is a session-gated GET with `no-store`.
- Input validation at every action boundary (Zod); domain re-validates critical invariants.
- Secrets are redacted recursively in logs and diagnostics. MeroShare CDSC username/password are AES-256-GCM encrypted at rest with `MERO_SHARE_ENCRYPTION_KEY`; its authorization header is in-memory for one sync only and is never persisted or logged. The encryption key can be rotated with `npm run meroshare:rotate-key`, which re-encrypts stored credentials transactionally (all-or-nothing) so a rotation never strands a household.

## Operations

- `/api/health` verifies DB reachability and migration currency for load balancers.
- Audit events capture auth, sharing, account lifecycle, transfer, split, export, and member
  changes with actor + metadata.
- Dead-letter jobs raise support-visible diagnostics; replay available in the admin console.

## Known deferred risks

- MFA/passkeys and SSO are not implemented — acceptable for self-hosted single-family use,
  not for a public managed offering without them.
- No automated dependency scanning in-repo; run `npm audit` / enable Dependabot in CI hosting.
