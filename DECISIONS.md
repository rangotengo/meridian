# Decisions

Recorded per the clone plan's requirement that scope and technology decisions precede
implementation. Source baseline: Sure `c44408ff` (dev-upstream-sync), reviewed 2026-08-12.

## Scope (launch)

| Module                                                       | Decision     | Notes                                                            |
| ------------------------------------------------------------ | ------------ | ---------------------------------------------------------------- |
| Identity/sessions                                            | Keep         | Email/password + verification; MFA/SSO deferred                  |
| Families, sharing                                            | Keep         | Family tenancy from day one; 3-level share permissions           |
| Manual accounts                                              | Keep         | depository, credit_card, other_asset, other_liability only       |
| Ledger/transfers/splits/valuations                           | Keep         | Full invariants; transfer fees deferred                          |
| Categories/tags                                              | Keep         | Merchant is a plain string; normalization deferred               |
| Reports/dashboard                                            | Keep         | Net worth, income vs expense, spending by category               |
| Budgets/goals/rules/recurring                                | Remove/Defer | Re-add with dedicated design after ledger stabilizes             |
| Investments, crypto, providers, AI, shared expenses, imports | Remove/Defer | Per removal-catalog recommended cuts                             |
| Export                                                       | Keep         | JSON family export for portability (non-negotiable privacy item) |
| Public API / mobile / desktop / PWA                          | Remove       | No compatibility promises                                        |

## Technology

| Concern          | Choice                                                         | Rationale                                                                                               |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Money storage    | bigint minor units + ISO currency                              | Exact fixed point; safe-integer bound documented                                                        |
| Sign convention  | Source convention preserved (outflow +)                        | Keeps upstream behavior ports mappable                                                                  |
| Migrations       | Hand-reviewed SQL with paired down-scripts                     | Auditable schema evolution; rehearsed up/down in CI                                                     |
| Auth             | In-house scrypt/session layer                                  | Small auditable surface over finance authorization                                                      |
| Queue            | Custom Postgres queue                                          | Durable, retry/dead-letter/cron semantics without Redis; exit path to pg-boss/graphile if scale demands |
| FX fallback      | Exclude + diagnostic on missing rate                           | Never silently wrong totals                                                                             |
| Opening balances | Explicit columns (display-signed) instead of anchor valuations | Simpler model for the four launched account types; deviation recorded                                   |

## Resolved ambiguities

- Transfer date window: ±4 calendar days (constant).
- Cross-currency transfers: rejected at launch.
- Splitting transfer legs: forbidden until unlink.
- Draft accounts: creatable but excluded from reports until activated; closed accounts reject
  mutations but retain history.
- Privacy mode: server-rendered masking via preference; nothing sensitive cached client-side.

## Follow-ups (explicit deferrals)

1. CSV import built atop the external-id dedupe index.
2. Transfer fees as a third linked transaction.
3. MFA/passkeys before any managed/public launch.
4. Versioned REST API behind explicit contract ownership.
5. Provider framework: connection + credentials + idempotent sync as one unit, no partial connectors.

## Addendum — scope changes since launch (2026-11-15)

The tables above record the launch decisions and are kept as history. Since
then, the following deferred/removed items have shipped: budgets, recurring
transactions, MeroShare portfolio sync (a provider connector with encrypted
credentials and idempotent sync), an AI chat surface, Sure data import, and
the Shortcuts API under `/api/v1`. A second backend (Cloudflare Workers with
SQLite Durable Objects) is supported alongside PostgreSQL. Registration also
became operator-controlled: `REGISTRATION_OPEN` can close public sign-up, and
super-admin **instance invitations** (distinct from family-admin member
invitations) are the invite-only path to a new household. Two seeded feature
flags remain unimplemented; see `docs/follow-ups-assessment.md`.
