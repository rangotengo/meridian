# MCP read-only access — Stage 2 evidence (self-hosted OAuth 2.1)

**Status:** Proof of concept built and verified locally on branch
`feat/mcp-readonly-poc` (base: master `2ae7d1e`). **Production is NOT
enabled** — the feature is behind a config gate that defaults to off, and
no deployment has been made. Real Claude/ChatGPT connection verification
is **PENDING** (Tier B, see "Evidence tiers").

**Decision history:** the design (Stage 1) evaluated external providers.
WorkOS AuthKit Standalone Connect was evaluated as an optional provider;
its pricing for this use could not be confirmed free from public sources,
and the owner then chose the **self-hosted** path outright. The WorkOS
path is closed — no WorkOS code, calls, or dashboard setup remain in this
build. The authorization server below is purpose-built inside Meridian,
per the Stage 1 design doc and the comparison doc's purpose-built column.
(The earlier Tier-A brief's WorkOS-specific binding columns —
`workos_sub` / `workos_client_id` / `workos_sid` — were generalized
before any of this was built: the binding carries **our own**
authorization server's `client_id`, and the **grant id** serves as the
consent/session identifier for the connection.)

---

## Architecture as built

```
Claude / ChatGPT (MCP client)
   │  1. GET /.well-known/oauth-protected-resource/mcp   (RFC 9728)
   │  2. GET /.well-known/oauth-authorization-server     (RFC 8414)
   │  3. POST /oauth/register                            (DCR, RFC 7591)
   │     — or the client_id is an https URL (CIMD)
   │  4. GET  /oauth/authorize → Meridian session login → consent page
   │  5. POST /oauth/token  (code + PKCE S256, or refresh_token)
   │  6. POST /mcp          (Bearer access token, JSON-RPC)
   ▼
Meridian (this codebase, both backends)
   ├─ src/server/domain/oauth.ts   — the authorization server + verifier
   ├─ src/server/mcp/server.ts     — McpServer, eight read-only tools
   ├─ src/server/mcp/ssrf.ts       — SSRF policy fetcher (Node/Workers)
   ├─ src/server/mcp/cimd.ts       — CIMD resolution + private_key_jwt
   └─ tables: oauth_clients, oauth_grants, oauth_authorization_requests,
              oauth_authorization_codes, oauth_tokens, oauth_assertion_claims
```

Meridian's existing session login is the only login of record. OAuth
never authenticates a user; it issues grants on top of a verified
session, and every resource call re-resolves authority from current
database state.

## Endpoint inventory

| Endpoint                                        | Purpose                                                 | Gate behavior         |
| ----------------------------------------------- | ------------------------------------------------------- | --------------------- |
| `POST/GET/DELETE /mcp`                          | MCP streamable-HTTP endpoint (stateless)                | 404 when unconfigured |
| `GET /.well-known/oauth-protected-resource`     | RFC 9728 metadata                                       | 404                   |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata (named in the 401 challenge)          | 404                   |
| `GET /.well-known/oauth-authorization-server`   | RFC 8414 metadata                                       | 404                   |
| `GET /oauth/authorize`                          | Consent page (session-gated)                            | 404 (notFound)        |
| `POST /oauth/token`                             | Code exchange + refresh rotation, form-encoded only     | 404                   |
| `POST /oauth/register`                          | DCR; rate-limited 10/h/IP                               | 404                   |
| `POST /oauth/revoke`                            | RFC 7009; always 200 for well-formed requests           | 404                   |
| `DELETE /api/mcp/connections/[id]`              | Owner disconnects a connection from Connected AI agents | 404                   |

## Config gate

Everything activates only when `MCP_ENABLED=true`. When unset/false,
all routes above return 404 and the rest of the app is untouched
(verified by test — see Tier A).

| Variable             | Meaning                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_ENABLED`        | `"true"` enables the whole surface. Default off.                                                                                                                                  |
| `MCP_RESOURCE_URL`   | The ONE canonical resource identifier (audience). Default `https://meridian.arunshrestha.info.np/mcp`. Used verbatim — never normalized, never derived from request Host headers. |
| `MCP_ISSUER_URL`     | Issuer identifier; defaults to `APP_URL`.                                                                                                                                         |
| `MCP_CIMD_ALLOWLIST` | Comma-separated exact CIMD/JWKS URLs approved by the operator. Required for CIMD on the Workers backend only (see SSRF).                                                          |

The `/mcp` host/origin guard is pinned from this config (canonical
resource + issuer hostnames ∪ loopback, via the SDK's
`hostHeaderValidationResponse` / `originValidationResponse` helpers) —
per the transport spike's finding that `wrangler dev` presents the
production hostname even for local requests.

## Data model

Both backends, mirrored (Postgres migrations 0009–0011; cloud 0010–0012):

- **`oauth_clients`** — DCR registrations: `id` (= client_id), name,
  redirect URIs (JSON), token-endpoint auth method, optional secret
  hash. CIMD clients are never stored; their document is the record.
- **`oauth_grants`** — one row per connection (the binding): user,
  **one household** (`family_id` bound at consent), client_id +
  client_name, scopes (JSON), account ceiling (`account_ids`; empty =
  all currently-accessible accounts), status, expiry (90 days),
  last-used, revocation. The grant `id` is the connection's
  consent/session identifier.
- **`oauth_authorization_requests`** — server-side consent records
  (10-minute TTL): user, session, household shown, client, redirect_uri,
  scopes, resource, code challenge, state, hash-stored CSRF token,
  consumed-at.
- **`oauth_authorization_codes`** — hash-stored, single-use codes
  (5-minute TTL), with `used_at` (atomic consume), `issued_at`
  (completed issuance), and `invalidated_at` (durable family revocation).
- **`oauth_assertion_claims`** — atomic `(client_id, jti)` replay
  claims retained through the assertion's expiry plus clock tolerance.
- **`oauth_tokens`** — opaque, hash-stored access (1 h) and refresh
  (30 d) tokens: grant, originating code (token-family root), resource
  (audience), expiry, revocation, `replaced_by_id` rotation chain.

Audit (existing `recordAudit`, metadata only — never payloads or free
text): `oauth_grant.created`, `oauth_grant.revoked`, `mcp.tool_called`.

## Consent and redirect safety

- Unauthenticated → `/sign-in?next=<authorize URL>` (sign-in gained a
  validated local `next` parameter: same-site paths only, no `//`, no
  backslashes, ≤1024 chars). Unverified email → `/verify-email`.
  Invite-only registration and verification are never bypassed.
- The consent page renders from a **server-side authorization-request
  record** created after full request validation. The decision forms
  submit only the record id + CSRF token; the actions consume the
  record **exactly once** (conditional UPDATE) after checking user,
  session, household, CSRF hash, and expiry. An approval therefore
  cannot be transplanted to a different client, redirect_uri, scope
  set, or household than the one displayed.
- **Redirects only ever go to the record's already-validated
  redirect_uri** (success and deny paths alike, always with the RFC
  9207 `iss` parameter). Every validation failure renders on Meridian's
  own error page — including error paths.
- **Every approval mints a NEW grant row.** Reconnecting never revives
  or extends an earlier grant; a revoked grant's access and refresh
  tokens stay dead (tested).

## Token semantics

- **PKCE S256 only** — `plain`, absent method (which defaults to plain),
  and absent challenge are all rejected at authorize time.
- **Codes are single-use** via atomic conditional UPDATE on both
  backends. A failed exchange attempt consumes the code (fail-closed).
- **Replay defense:** presenting a consumed code durably invalidates
  its token family. Issuance and invalidation lock code → grant → token
  rows in the same order, and token verification checks the persistent
  marker. An exchange interrupted before issuance cannot mint a live
  token after invalidation; an already-issued pair becomes unusable.
  Simultaneous exchanges have at most one winner, whose tokens are
  also revoked when replay is detected.
- **Refresh tokens rotate** on every use. Presenting a rotated-out or
  revoked refresh token revokes the whole family (OAuth 2.1 §4.3.1).
  Under simultaneous refresh, exactly one succeeds and the loser's
  reuse handling revokes the family — including the winner's new pair,
  which is the BCP-conformant reading of a rotation race (it is
  indistinguishable from token theft).
- **Audience** is the configured canonical resource, checked at
  authorize time (mismatch → `invalid_target`), at token time, and on
  every resource call (token row's `resource` must equal it exactly).
- **Per-call re-resolution:** token → grant active/unexpired → user
  exists and not removed → `user.familyId === grant.familyId` (a
  household move **rejects**; the grant never follows the user) →
  account access re-intersected with the grant's ceiling in the tool
  handler. The effective authority is always the **intersection** of
  the consented grant and the user's current permissions.
- **MCP actors always get `platformRole: "user"`** (the API-key
  precedent), even for super-admins.
- Revocation (RFC 7009 endpoint or the connections API) is effective on
  the very next call — verification is a live DB read.

## Scopes

Issued set: `finance:read`, `transactions:read`, `transactions:notes`,
plus `offline_access` (refresh). Nothing else is ever granted, and no
scope permits a write. `offline_access` appears only in
authorization-server metadata, **not** in protected-resource metadata
(2025-11-25 MCP profile). Scopes are enforced **inside the tool
handler** (`get_financial_summary` requires `finance:read`); tool
annotations (`readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`) are presentation only.

## The tool

`get_financial_summary` over the bound household, built entirely on the
existing domain services (`dashboardSummary`, `latestBalancesFor`,
`convertMinor` — no new financial math): net worth, assets, liabilities,
month income/expenses, per-account balances (own currency + base
conversion), top categories. Amounts are integer minor units as
**strings**, each with `currency` and `currencyExponent`; household
timezone, `asOf`, `balancesAsOf`, and the FX completeness block
(`fx.complete`, missing rates with excluded amounts, rates used)
reusing the existing FX plumbing are included.

## SSRF policy for client-metadata fetching — per backend

CIMD documents and JWKS are fetched from client-supplied URLs, so the
fetch policy is the trust control; `jose` verifies signatures but never
fetches anything itself (JWKS is loaded via `createLocalJWKSet` from
policy-fetched JSON).

**Node / Postgres backend — resolve, validate, pin** (`src/server/mcp/ssrf.ts`):

- HTTPS only; no URL credentials; `localhost` names refused.
- DNS is resolved **before** connecting; **every** resolved address is
  checked against RFC 6890 special ranges (private, loopback,
  link-local incl. 169.254.0.0/16, CGNAT, documentation, benchmarking,
  multicast, reserved, unspecified) — including IPv4-mapped,
  IPv4-compatible, NAT64, and 6to4-embedded forms. Any blocked address
  refuses the fetch.
- The connection is **pinned** to a validated address via a custom DNS
  lookup in `node:https` — the address checked is the address dialed.
- Redirects are followed manually (max 3); **each hop re-runs the full
  policy** including fresh DNS resolution.
- 5 s timeout, 32 KB response cap, JSON content-type required.

**Cloudflare / Workers backend — operator allowlist** (owner acceptance
condition 1): workerd's `fetch()` resolves independently and offers no
destination pinning, so a resolve-then-fetch sequence would be a
TOCTOU/DNS-rebinding hole and is **not** claimed as enforcement.
Instead, on this backend CIMD/JWKS fetching is restricted to exact URLs
in `MCP_CIMD_ALLOWLIST`; anything else is refused before any network
call. DCR clients (Claude/ChatGPT's registration path) are unaffected —
they require no fetching. If no CIMD client is ever needed on the
Workers deployment, the allowlist simply stays empty and CIMD stays
off there.

Per-backend test evidence is in Tier A below (Node policy cases on
Postgres; allowlist gate cases in the workerd harness).

## Cloudflare Access note (corrected exception list)

If interactive Cloudflare Access is ever enabled on the production
hostname, these machine-facing paths must bypass it (MCP OAuth remains
the authentication on them; browser paths may stay behind Access):

`/mcp`, `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, `/oauth/token`,
`/oauth/register`, `/oauth/revoke`.

## Evidence tiers

### Tier A — protocol/backend evidence (this build, simulated clients)

All tests use locally minted tokens/documents and stub fetchers — they
prove the protocol and backend behavior, **not** real-client
interoperability.

| Suite                                       | Result                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Postgres full suite (`npm test`)            | **416 passed / 51 files** (transport-spike baseline on master: 377 / 50 files; the new MCP file contributes 38) |
| MCP integration file                        | **38 passed**, re-run 3× (concurrency stability)                                                                |
| Cloud suite (`npm run test:cloud`, workerd) | **20 passed** (baseline 19; +1 MCP probe with 13/13 flags)                                                      |
| Typecheck / lint / format                   | clean                                                                                                           |
| `npm run build:next` (Node)                 | succeeds; all 9 new routes present                                                                              |
| `npm run build` (OpenNext/Workers)          | succeeds                                                                                                        |

Negative/edge cases proven (Postgres unless noted):

- PKCE: `plain` rejected, absent method rejected, absent challenge
  rejected; wrong verifier rejected **and consumes the code**.
- redirect_uri: unregistered at authorize rejected; mismatched at token
  rejected. Wrong `resource` → `invalid_target` at authorize and token.
  Unknown scope → `invalid_scope`. Non-`code` response type rejected.
- Consent record: wrong CSRF rejected; different session rejected;
  different user rejected; household changed after display rejected;
  double consumption rejected (PG + cloud).
- Code replay, sequential, **via a separate DB connection**: rejected,
  first exchange's tokens revoked (PG + cloud).
- **Simultaneous** code exchanges on separate connections: exactly one
  succeeds; the replay path revokes the family (PG + cloud).
- Refresh: rotation works; replaying a rotated-out token →
  `invalid_grant` + whole family dead (PG + cloud). **Simultaneous**
  refreshes: exactly one succeeds, reuse handling engages (PG + cloud).
- No refresh token issued without `offline_access`.
- Two connections for one user (Claude/ChatGPT simulation): revoking
  one leaves the other working; a different user cannot revoke it.
- Revoke + reconnect: **new grant row**; old access **and** refresh
  tokens stay dead; new connection works.
- RFC 7009: access revocation effective immediately; refresh
  revocation kills the family.
- Household move → rejected (never redirected); `removedAt` → rejected;
  wrong-audience token row → rejected; super-admin's MCP actor is
  `platformRole: "user"`.
- DCR policy: arbitrary internet redirect URIs rejected; claude.ai /
  chatgpt.com callbacks and loopback accepted; confidential client with
  wrong secret → `invalid_client`.
- CIMD: valid document resolves; `client_id` ≠ URL rejected;
  redirect_uri outside the document rejected; `private_key_jwt` with
  the document's JWKS verifies; wrong signing key → `invalid_client`.
- SSRF (Node policy): http refused; 127.0.0.1, ::1, ::ffff:127.0.0.1,
  10.0.0.5, localhost refused **before any fetch**; hostname resolving
  to a private address refused; redirect to 169.254.169.254 refused;
  validated redirect followed with pinned addresses passed to the
  transport; non-JSON content-type refused; unresolvable host refused.
- SSRF (Workers gate, in workerd): CIMD resolution refused without an
  allowlist entry, allowed with one (cloud probe).
- Route level: `/mcp` initialize + `tools/call` return the summary;
  figures cross-checked against the balances table (balance 75000 =
  100000 opening − 25000 expense; net worth equals the single account's
  base balance; `fx.complete: true`); `mcp.tool_called` audit written;
  missing/garbage bearer → 401 with the `resource_metadata` challenge;
  scope-less grant → tool-level `isError` naming `finance:read`.
- **Gate closed** (acceptance condition 5): with MCP unconfigured,
  `/mcp`, both discovery documents, token, registration, and revocation
  endpoints all return 404; the rest of the app is unaffected (the full
  suite runs unconfigured by default and stays green).

Transport evidence from the spike (separate branch
`spike/mcp-transport`, commit `4ca22d7`) is incorporated: one route file
serves both runtimes; protocol revisions 2025-03-26 / 2025-06-18 /
2025-11-25 negotiated on Node, the first two on Workers with identical
payloads; root-export SDK imports only; no validator adaptation needed.

### Tier B — real-client verification (PENDING)

None of this has happened yet; it requires the owner's accounts and a
configured deployment:

- Connect a real **Claude** account (custom connector) and a real
  **ChatGPT** account (Plugins → Add custom MCP server) end to end.
- **Plan eligibility is unconfirmed**: ChatGPT Free/Plus are not
  documented for custom MCP (Pro documents read/fetch only, which is
  sufficient for this release); Claude Free allows 1 custom connector.
  Eligibility is established only by an actual connection attempt.
- Observe the real clients' DCR/CIMD behavior against this AS
  (redirect URIs, assertion use, refresh cadence).
- The refresh-replay live procedure from the earlier WorkOS phase is
  obsolete — replay behavior is now Meridian-side and covered in
  Tier A.

## Production enablement checklist (owner, later stage — NOT done)

1. Deploy a build containing this feature to Coolify (both apps).
2. Set on the web app (and worker, for parity): `MCP_ENABLED=true`,
   `MCP_RESOURCE_URL=https://meridian.arunshrestha.info.np/mcp`,
   `MCP_ISSUER_URL=https://meridian.arunshrestha.info.np`.
3. Only if CIMD clients must work on a Workers deployment: populate
   `MCP_CIMD_ALLOWLIST` with the exact approved metadata URLs.
4. If Cloudflare Access is enabled on the hostname, add the exception
   list above.
5. Connect one real client (Tier B) and verify before announcing.

No WorkOS account or dashboard setup is needed — that path is closed.

## Known PoC limitations

- **Account ceiling is all-accessible**: grants record an empty
  `account_ids` (the intersection logic honors a ceiling, but the
  consent page has no account picker yet — later stage). _Resolved in
  Stage 4 (below): the consent page has an account picker and the
  settings page names the ceiling._
- **Settings UI**: connections can be revoked via
  `DELETE /api/mcp/connections/[id]`; a connections settings page is a
  later stage. _Resolved in Stage 4 (below): Connected AI agents
  settings page, with disconnect wired to that same route._
- **CIMD cache** is in-memory per instance (≤1 h TTL, 200-entry cap);
  a fleet-wide cache is future work. Nightly cleanup removes abandoned
  DCR registrations older than 30 days that never produced a grant.
- The Node metadata transport pins the **first** validated address;
  all resolved addresses are validated, but connection failover across
  them is not attempted.
- At Stage 2, `get_financial_summary` was the only tool and the
  `transactions:read` / `transactions:notes` scopes were issued but
  unconsumed. Stage 3 (below) adds the remaining seven tools and
  consumes all three read scopes.

---

# Stage 3 — the remaining seven tools

Stage 3 completes the release-1 tool set on the same `/mcp` endpoint,
the same per-call authority path (grant scopes + account ceiling ∩
current permissions, bound household, actor `platformRole: "user"`),
and the same config gate. No new financial math: every figure comes
from an existing domain/report service. Read-only is structural — the
MCP module imports no mutation service, guarded by
`tests/unit/mcp-boundary.test.ts` (import allowlist + a check that
every registered tool has a `TOOL_SCOPES` entry and a matching
in-handler `requireScope(TOOL_SCOPES.<tool>)` call).

## Tool inventory and scope map (`src/server/mcp/scopes.ts`)

| Tool                          | Scope                                                                       | Service reuse                                                                      |
| ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `get_financial_summary`       | `finance:read`                                                              | `dashboardSummary`, `latestBalancesFor`, `convertMinor` (Stage 2)                  |
| `list_accounts`               | `finance:read`                                                              | `latestBalancesFor`, `getRateInfo` + `convertMinor` for base-currency balances     |
| `search_transactions`         | `transactions:read` (+`transactions:notes` for note text)                   | `listEntriesPage` (extended with `accountIds`, `searchNotes`, `withTotal`)         |
| `get_spending_breakdown`      | `finance:read`; merchant grouping additionally requires `transactions:read` | `spendingByCategory`, new `spendingByMerchant` (same FX plumbing)                  |
| `get_income_expense_trend`    | `finance:read`                                                              | `incomeExpenseSeries`                                                              |
| `get_budget_progress`         | `finance:read`                                                              | `budgetOverview`                                                                   |
| `list_recurring_transactions` | `finance:read`                                                              | `listSeries`, `nextOccurrence`, posted-entry lookup on `entries.recurringSeriesId` |
| `get_net_worth_history`       | `finance:read`                                                              | `netWorthSeries` over the materialized daily snapshots                             |

The authorization server issues exactly `finance:read`,
`transactions:read`, `transactions:notes` (+`offline_access`), so
every scope in the map is issuable; the boundary test fails if a tool
is ever mapped to a scope outside that set. Enforcement is inside each
handler; a grant lacking the scope gets a clean MCP error naming the
missing scope. Annotations remain presentation only
(`readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`, `idempotentHint: true`).

Supporting domain changes (all optional parameters, existing callers
unchanged): report services (`netWorthSeries`, `incomeExpenseSeries`,
`spendingByCategory`, `budgetOverview`) accept an optional account-id
restriction used to apply the grant ceiling inside the aggregation
itself (undefined = unrestricted, empty = matches nothing);
`listEntriesPage` accepts an account-id filter, a `searchNotes` switch
(when false, text search matches name + merchant only — note text is
not even _searchable_ without the notes scope), and `withTotal` for an
exact match count over the same filter conditions.

## Output and completeness rules

- Every payload carries the household envelope (name, base currency,
  timezone) and an `asOf` timestamp; money is integer minor units as
  strings with `currency` + `currencyExponent` per amount.
- Cross-currency aggregations carry the Stage 2 `fx` block
  (`complete`, `ratesUsed`, and when incomplete a `warning` plus
  `missingRates` with per-pair excluded amounts). Unrated amounts are
  excluded from totals **and flagged** — never silently converted,
  never presented as a complete total.
- `search_transactions` paginates with an opaque cursor
  (date + entry id), default page 50, maximum 100 (the underlying
  service cap), and always returns `page.totalMatching` (exact count
  over the filters), `hasMore`, and `nextCursor`, so partial results
  are never presented as complete. An `accountId` filter outside the
  visible set returns an empty page — account existence is not leaked.
- An account with no balance snapshot reports `amountMinor: null`,
  not zero.
- `list_recurring_transactions` keeps actuals and projections in
  separate fields with separate statuses: `actualPostings`
  (`status: "posted"`, real ledger entry ids) vs
  `scheduledOccurrences` (`status: "scheduled"`, generated from
  `nextDue` via `nextOccurrence`, active series only), plus a
  top-level `distinction` note. A scheduled occurrence can never look
  like a posted transaction.
- `get_net_worth_history` reports `coverage`
  (`daysInRange`, `daysWithSnapshots`, `missingDays`, explicit
  `gaps[]`, `complete`); days without snapshots are reported missing,
  never interpolated or zero-filled.

## Stage 3 evidence (Tier A — simulated clients, as before)

- **Postgres**: full suite **442 passed / 53 files** (Stage 2
  baseline 416/51; all Stage 2 tests still green). New:
  `tests/integration/mcp-tools.test.ts` (**20 tests**) — per-tool
  happy paths cross-checked against seeded ledger truth and the
  source services' own outputs; per-tool scope denial naming the
  missing scope (including the full finance-tool matrix against a
  transactions-only grant, and merchant grouping denied without
  `transactions:read`); ceiling intersection across list, search, and
  breakdown; cross-household isolation; notes excluded without
  `transactions:notes` (field null _and_ note text unsearchable) and
  included with it; pagination contract (7 entries, page 3 → 3/3/1,
  cursor chaining with no duplicates, `totalMatching` = 7 on every
  page, reproducible first page); recurring actual-vs-scheduled shape
  (posted entry id matched to the ledger row); budget FX-incomplete
  case (JPY spending with no JPY→USD rate: excluded amount flagged in
  `fx.missingRates`, USD spending still counted); net-worth coverage
  (full 7-day window, plus pre-history ranges reported as gaps with
  zero points — not zeros). `tests/unit/mcp-boundary.test.ts`
  (**5 tests**) guards the structural rules above.
- **Cloud (workerd/Durable Objects)**: suite **21 passed** (Stage 2
  baseline 20). New `/mcp-tools` probe op (**10 flags**): list/search
  happy paths, notes excluded + unsearchable without the scope and
  included with it, scope denial both directions, cross-household
  isolation, merchant breakdown, and the Stage 2 summary on the same
  runtime.
- **Builds/checks**: `build:next` and the OpenNext cloud build pass;
  typecheck, lint, and prettier are clean.

## Tier separation — unchanged

Tier B (real Claude/ChatGPT connections) remains **PENDING**; nothing
in Stage 3 changes that, and production enablement remains a separate
later decision (checklist above).

## Stage 3 limitations

- The consent page still has no account picker, so in practice grant
  ceilings are empty (all accessible accounts) until that later stage;
  the ceiling path itself is fully implemented and tested by setting
  `oauth_grants.account_ids` directly. _Resolved in Stage 4 (below):
  ceilings are now set through the consent flow itself._
- `search_transactions` page size is capped at 100 by the underlying
  `listEntriesPage` service (design default 50 retained).
- Scheduled-occurrence projection is computed from `nextDue` with the
  series' frequency config; it does not model future edits, pauses
  after the first occurrence, or catch-up posting behaviour beyond
  what `nextOccurrence` encodes.

---

# Stage 4 — Connected AI agents settings page + consent account picker

Stage 4 closes the two Stage 2/3 limitations above: connections are
now visible and manageable in the app, and grant account ceilings can
be set at consent time instead of only by writing the grant row.

## Connected AI agents settings page

- Route: `/settings/ai-agents`, linked from the settings navigation's
  Account section as "Connected AI agents". It follows the existing
  settings patterns (server page + `PageHeader` + client manager, as
  with API keys) and renders from `listConnectionsForUser`
  (`src/server/domain/oauth.ts`) — the signed-in user's grants only.
- Each connection shows: client name (the grant's stored name from the
  DCR registration or CIMD document), the household it is bound to,
  permissions in plain language (`SCOPE_LABELS` in
  `src/server/mcp/scopes.ts`, kept beside the consent page's
  `SCOPE_DESCRIPTIONS` so scope wording lives in one module), account
  access ("All accounts you can access", or the ceiling's account
  names), connection date, last-used timestamp, expiry for active
  connections, and a status badge (Active / Disconnected / Expired).
- **Access history**: per connection, the latest 10 audit events for
  that grant — `oauth_grant.created`, `mcp.tool_called` (tool name
  only), `oauth_grant.revoked` — newest first, formatted in the bound
  household's timezone (e.g. "Nov 15, 2:41 PM — get_financial_summary").
  Metadata only; no payloads or free text, matching the audit design.
- **Disconnect**: a confirmation dialog (the design system's `Dialog`)
  whose confirm calls the existing owner-checked
  `DELETE /api/mcp/connections/[id]` route, then refreshes. Revocation
  semantics are unchanged — tokens die on the next call because
  verification reads grant state live.
- The page carries a short explainer: results are generated by the
  connected assistant's provider, Meridian data returned by tools is
  sent to that provider and handled under the provider's policies.
- **Gate independence**: the page and `listConnectionsForUser` never
  consult `mcpConfig()`. The grants tables exist regardless of the
  config gate, so the page renders (with an empty state when there is
  nothing to show) even when MCP is unconfigured; with the gate closed
  no token can be used anyway. (The DELETE route itself still 404s
  while unconfigured, as Stage 2 specified for the whole MCP surface.)

## Last-used tracking

No migration was needed: `oauth_grants.last_used_at` has existed on
both backends since migration 0009/0010, and `resolveMcpAccess`
already stamps it (and the token's own `last_used_at`) on every
verified MCP call — one indexed-row update per call, the same pattern
as API keys and sessions. Stage 4 surfaces the value on the settings
page and adds the missing proof: tests assert it is null before any
call and advances after a real tool call, on both backends.

## Consent account picker

- The authorize page now lists the accounts the user can access in the
  bound household (the same `accessibleAccountIds` rule the tools
  enforce) as checkboxes, all checked, when there is more than one.
  The checkboxes belong to the approve form via the HTML `form`
  attribute; a hidden `account_selection` marker distinguishes
  "picker offered, everything unchecked" from "no picker rendered".
- The selection is the one consent CHOICE the form carries (everything
  else still comes from the server-side record). At approval,
  `approveAuthorizationRequest` validates it via
  `resolveConsentAccountCeiling` before minting anything:
  - every submitted id must be an account the consenting user can
    access **right now** in the record's bound household;
  - **validation rule: fail closed** — an empty selection, or ANY
    inaccessible id (foreign household, deleted, or never accessible),
    rejects the whole approval with `invalid_request` and no grant is
    minted; ids are never silently dropped;
  - selecting every accessible account stores the empty ceiling
    ("all accounts", re-resolved per call), so the common case keeps
    the Stage 2/3 semantics; a true subset is stored in
    `oauth_grants.account_ids` and the existing per-call intersection
    enforces it.
- CSRF and single-consumption semantics are untouched: the record is
  still consumed exactly once before approval runs, so a rejected
  selection simply ends the flow (the user restarts from the client),
  like any other invalid consent decision.

## Stage 4 evidence (Tier A — simulated clients, as before)

- **Postgres**: full suite **449 passed / 54 files** (Stage 3 baseline
  442/53; all prior tests green). New
  `tests/integration/mcp-settings.test.ts` (**7 tests**): connection
  list isolation (each user sees only their own, with household name,
  active status, created-only history; a user with none gets an empty
  list); expired status derivation; consent subset stored on the grant
  **through the consent flow** and constraining `list_accounts` and
  `search_transactions`; all-accounts-selected storing the empty
  ceiling; foreign and mixed inaccessible ids rejected with no grant
  minted; empty selection rejected; last-used advancing on a tool call
  with history recording created → tool_called (tool named) → revoked,
  newest first.
- **Cloud (workerd/Durable Objects)**: suite **22 passed** (Stage 3
  baseline 21). New `/mcp-settings` probe (**7 flags**): ceiling stored
  through the consent flow; foreign id rejected; settings list shows
  the connection with household name, named ceiling account, active
  status and created history; other household's list empty; a real
  `get_financial_summary` call advances last-used and records
  `mcp.tool_called`; revoke flips the listed status, records the
  revocation at the head of the history, and kills token resolution.
  Harness note: the probe consumes the `/mcp` SSE response body before
  asserting — the handler's trailing audit insert completes as the
  stream is read, as a real client would observe.
- **Builds/checks**: `build:next` and the OpenNext cloud build pass;
  typecheck, lint, and prettier are clean.

## Tier separation — unchanged

Tier B (real Claude/ChatGPT connections) remains **PENDING**; nothing
in Stage 4 changes that, and production enablement remains a separate
later decision (checklist above).

## Stage 4 limitations

- The picker offers accounts only; there is still no per-connection
  scope editing — scopes remain whatever the client requested and the
  user approved as a set.
- Access history is capped at the latest 10 events per connection and
  is not paginated.
- Disconnect from the settings page needs the MCP gate configured
  (the DELETE route 404s while unconfigured, per the Stage 2 closed-
  gate rule); the page itself renders and lists connections either
  way, and with the gate closed no token is usable regardless.

---

# Review fix round — PR #13 security review (2026-11-15)

Eight findings from the owner's review of head `428321b`, plus three
follow-ups. All fixes are Tier A evidence (simulated clients, both
backends); **Tier B remains PENDING** and production enablement is
unchanged (separate decision, gate still defaults closed).

## P1-1 — summary honors the grant restriction

`dashboardSummary` now takes the accessible-account intersection and
applies it to every subquery (balances, month flows, top categories,
recent entries) — the same restriction plumbing the report services
already had. The MCP summary handler computes the visible set first
and passes it through, so net worth, assets/liabilities, income,
expenses, top categories and FX completeness cover exactly the
accounts the connection may see; an empty intersection yields an
all-zero, FX-complete summary (fail closed). Regression: the owner's
exact two-account repro (A-only net worth 100000, excluded 40000 of
spending and its category name absent), an excluded-only missing-FX
case, and a loss-of-share case (share row deleted → account drops out
of the summary with no ceiling change). Covered on Postgres and in
the workerd probe.

## P1-2 — durable family invalidation (the settle-wait design is gone)

The 2-second settle wait and visible-row sweep are deleted. The
replacement is persistent state plus transactional coordination:

- `oauth_authorization_codes.invalidated_at` is the family marker
  (migration PG `0011` / cloud `0012`). Every token of a family hangs
  off exactly one code row, so one marker covers code exchange,
  rotation descendants, and revocation.
- Replay/reuse detection runs `applyFamilyInvalidation` in ONE
  transaction: stamp the marker, revoke the grant, sweep the family's
  token rows (by code, else by grant).
- Every issuance path (code exchange, refresh rotation) inserts
  tokens only inside a transaction that first locks the code row,
  then the grant row, then (for refresh) the presented token row —
  `SELECT … FOR UPDATE` on Postgres — and re-checks the marker and
  grant status under those locks before inserting. An issuer paused
  anywhere before its insert therefore either commits before the
  invalidation transaction can acquire the code-row lock (and its
  rows are then swept) or resumes inside a transaction that sees the
  marker and refuses. There is no window in which credentials can be
  published after invalidation.
- Verification (`resolveMcpAccess`) also rejects any token whose code
  row carries the marker — belt and braces behind the row sweep.
- Cloud: the Durable Object executor serializes all storage access
  behind a mutex and runs each `exec.transaction` inside
  `storage.transaction`, so the same code paths are atomic by
  construction; the PG lock interleavings have no analogue. The cloud
  probe asserts the invariant outcome (descendant refresh rejected,
  descendant pair dead after a reuse invalidation).

Regressions reproduce BOTH owner interleavings on Postgres with real
lock waits (a table lock pausing the winner between code consumption
and token insertion; a row lock blocking the revocation mid-sweep
while a descendant refresh queues behind it), asserting the marker,
the revoked grant, and zero surviving credentials. Run repeatedly —
stable.

## P1-3 — Node pinned lookup speaks the happy-eyeballs protocol

The DNS pinning lookup now returns an array of `{ address, family }`
when Node calls it with `{ all: true }` (autoSelectFamily) and the
single-address shape otherwise; pinning is unchanged (the dialed
addresses are exactly the validated ones). Regression uses the REAL
`node:https` transport against a local TLS server — only
`resolveHost` is stubbed — fetching a document end-to-end through the
pinned lookup; reverting the lookup to the old bare-string shape
fails the test with the original `ERR_INVALID_IP_ADDRESS`. (In this
sandbox the fetcher's own address policy blocks every locally
bindable address, so the transport function is exercised directly
rather than through `createMetadataFetcher`; the fetcher loop itself
is covered by the deadline/redirect tests with a recording transport
and by the workerd probe.)

## P1-4 — Workers redirects: allowlist enforced per hop

Chosen option: **enforce-per-hop** (not refuse-redirects). When the
fetcher runs on the cloud backend and an allowlist is supplied, every
hop's URL — initial and each redirect target — must exactly match an
allowlist entry before any network I/O for that hop; CIMD passes its
allowlist for both the document and JWKS fetches. The Node path is
unchanged (per-hop DNS validation already applies). Workerd probe:
an approved URL 302ing off-allowlist is rejected and the second URL
is never fetched; a redirect to a second allowlisted URL proceeds.

## P1-5 — CIMD redirect URIs validated under the DCR policy

One shared policy (`oauthRedirectUriAllowed`) now backs DCR
validation and CIMD document validation: every `redirect_uris` entry
must parse, carry no credentials and no fragment, and be either
HTTPS on `claude.ai`/`chatgpt.com` or HTTP on a loopback host —
anything else (`javascript:`, `data:`, other hosts, malformed)
rejects the whole document before consent. The loopback exception in
`redirectUriAllowed` is tightened to the registered host + path +
query (port may differ, for native-app loopback); previously any
loopback registered URI authorized any loopback target.

## P2-6 — private_key_jwt assertions: exp/iat/jti required, jti claimed

Verification requires `exp` per RFC 7523 §3, plus `iat` and `jti` under
Meridian's lifetime and one-use policies. It enforces
`0 < exp − iat ≤ 300s`, rejects future-issued assertions beyond 30s
clock tolerance, and — after signature
verification — atomically claims `(client_id, jti)` in the new
`oauth_assertion_claims` table (both databases) until the assertion's
expiry **plus clock tolerance**; a conflict means replay and the
authentication fails, including during the grace window after `exp`.
Tests: missing exp/iat/jti, 10-minute lifetime, expired, future-issued,
negative lifetime, clock-skew replay, sequential
replay, and concurrent replay (exactly one of two simultaneous
identical assertions succeeds, on Postgres; sequential replay is
asserted in the workerd probe).

## P2-7 — snapshot completeness told honestly

(a) `netWorthSeries` now computes, per emitted date, which in-scope
accounts (opened on or before that date) lack a snapshot, returning
`incompleteDates`. The MCP handler marks those points
`complete: false` with `missingAccountIds`, reports them under
`coverage.partialDays`, and `coverage.complete` is true only when
there are neither missing nor partial days. (The web reports UI uses
the same service; the field is additive and ignored there.)
(b) The summary's per-account `amountMinor` is `null` (unknown) when
an account has no balance snapshot — previously a missing snapshot
surfaced as `"0"` next to `fx.complete: true`. Tests cover both,
including the owner's delete-one-snapshot repro, deletion of all
snapshots for one of two accounts, and a newer account whose earlier
snapshots are correctly not expected before its opening date.

## P2-8 — stored resource is authoritative

Code exchange and refresh now reject when the STORED code/token
resource differs from the configured canonical resource, and
`issueTokenPair` writes the stored audience (never the current
config), so rotation preserves the original resource. A resource
change therefore requires fresh consent: old refresh tokens return
`invalid_grant` under the new config and stay usable under the old
one (asserted both ways, both backends).

## F1 — bounded growth

- CIMD caches (documents and JWKS) are capped at 200 entries each
  with oldest-first eviction (TTL unchanged at ≤ 1h).
- `cleanupOAuthHousekeeping` runs in the existing
  `maintenance:cleanup` job: expired assertion claims are deleted,
  authorization requests expired for over a day are deleted, and DCR
  clients older than 30 days that never produced a grant are deleted
  (the 10/hour/IP registration cap stays). Authorization codes and
  tokens are deliberately NOT pruned — consumed codes anchor family
  invalidation and replay forensics.

## F2 — absolute fetch deadline

Metadata fetches carry a total deadline (default 5s): the fetcher
computes one deadline up front, each hop's transport timeout is the
shrinking remainder, DNS validation is raced against the budget, and
the Node transport destroys the request at the absolute deadline in
addition to its inactivity timeout; the fetch transport's
AbortSignal carries the remainder per hop. Regression: a slow-drip
peer (one byte per 100ms) is cut off at the deadline instead of
holding the fetch open; a redirect chain cannot reset the budget.

## F3 — backup/restore contract for OAuth state

- **Household export/restore: OAuth state does NOT migrate.** The
  household export enumerates data domain-by-domain and contains no
  OAuth tables — verified by test (no `oauth` keys, no grant ids, no
  token hashes in the export). After a household restore, connected
  agents must reconnect; grants and tokens are never carried across.
- **Operator instance backups: OAuth state IS included.** The
  `oauth_*` tables were in fact missing from the enumerated instance
  table list; they are now exported/restored with the rest of the
  instance (same precedent as API keys), so a full-instance restore
  preserves connections. Restores from backups taken before this
  change still work (absent tables are tolerated).

## Fix-round evidence (Tier A)

- Postgres suite before final re-review: **470/470** across 56 files (was 449) — includes
  the new `mcp-review-fixes` file (6), the real-transport SSRF suite
  (4), and additions to `mcp-oauth` (38→42), `mcp-tools` (20→25).
- Cloud suite: **23/23** (was 22) — new `mcp-ssrf-redirect` probe op;
  `mcp-oauth` and `mcp-tools` probes extended with the P1-1, P1-2,
  P2-6, P2-7a, P2-8 flags.
- Typecheck, lint, prettier clean; `build:next` and the OpenNext
  cloud build both pass.

Final re-review adds two history regressions (all snapshots absent for
one account, and the account-opening boundary), plus assertion checks
for future issuance, negative lifetime, and replay inside clock
tolerance. The latter replay and future-issuance checks also run in the
workerd OAuth probe. PostgreSQL: **472/472** across 56 files; cloud:
**23/23**. No real Claude or ChatGPT connection has been
tested; Tier B remains pending, and enabling MCP is a separate approval.
