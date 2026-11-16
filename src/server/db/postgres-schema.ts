import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const families = pgTable("families", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  locale: text("locale").notNull().default("en"),
  timezone: text("timezone").notNull().default("Etc/UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    accessSubject: text("access_subject").unique(),
    name: text("name").notNull(),
    familyRole: text("family_role").notNull().default("member"),
    platformRole: text("platform_role").notNull().default("user"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    preferences: jsonb("preferences").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    index("users_family_idx").on(t.familyId)
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)]
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose)]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("api_keys_family_idx").on(t.familyId),
    index("api_keys_user_idx").on(t.userId),
    uniqueIndex("api_keys_key_hash_unique").on(t.keyHash)
  ]
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    familyRole: text("family_role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("invitations_family_idx").on(t.familyId)]
);

export const instanceInvitations = pgTable(
  "instance_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("instance_invitations_email_idx").on(t.email)]
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    color: text("color"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("categories_family_name_unique").on(t.familyId, sql`lower(${t.name})`),
    uniqueIndex("categories_family_external_dedupe_idx")
      .on(t.familyId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index("categories_parent_idx").on(t.parentId)
  ]
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("tags_family_name_unique").on(t.familyId, sql`lower(${t.name})`),
    uniqueIndex("tags_family_external_dedupe_idx")
      .on(t.familyId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`)
  ]
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    balanceTracking: text("balance_tracking").notNull().default("valuation"),
    subtype: text("subtype"),
    name: text("name").notNull(),
    institution: text("institution"),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").notNull().default("active"),
    includedInReports: boolean("included_in_reports").notNull().default(true),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" }).notNull().default(0),
    openedOn: date("opened_on").notNull(),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("accounts_family_idx").on(t.familyId),
    uniqueIndex("accounts_family_external_dedupe_idx")
      .on(t.familyId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`)
  ]
);

export const accountShares = pgTable(
  "account_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("account_shares_unique").on(t.accountId, t.userId)]
);

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    parentEntryId: uuid("parent_entry_id"),
    recurringSeriesId: uuid("recurring_series_id").references(() => recurringSeries.id, {
      onDelete: "set null"
    }),
    date: date("date").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    name: text("name").notNull(),
    notes: text("notes"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    entryableType: text("entryable_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Sequence-backed insertion order (migration 0014): the final
    // tiebreaker when balances order same-date valuations by created_at.
    // The cloud schema has no equivalent column — the balance engine
    // tie-breaks by SQLite's rowid there instead.
    writeSeq: bigint("write_seq", { mode: "number" })
      .notNull()
      .default(sql`nextval('entries_write_seq')`)
  },
  (t) => [
    index("entries_account_date_idx").on(t.accountId, t.date, t.id),
    index("entries_parent_idx").on(t.parentEntryId),
    index("entries_recurring_idx").on(t.recurringSeriesId),
    uniqueIndex("entries_external_dedupe_idx")
      .on(t.accountId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`)
  ]
);

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  merchant: text("merchant"),
  transferId: uuid("transfer_id")
});

export const valuations = pgTable("valuations", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("current")
});

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  outflowEntryId: uuid("outflow_entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  inflowEntryId: uuid("inflow_entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("confirmed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const transactionTags = pgTable(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" })
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.tagId] }),
    index("transaction_tags_tag_idx").on(t.tagId)
  ]
);

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    quoteCurrency: char("quote_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
    quotedOn: date("quoted_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("exchange_rates_pair_date_unique").on(t.baseCurrency, t.quoteCurrency, t.quotedOn),
    index("exchange_rates_pair_date_idx").on(t.baseCurrency, t.quoteCurrency, t.quotedOn)
  ]
);

export const balances = pgTable(
  "balances",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    balanceMinor: bigint("balance_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull()
  },
  (t) => [primaryKey({ columns: [t.accountId, t.asOf] })]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id").references(() => families.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("audit_events_family_created_idx").on(t.familyId, t.createdAt)]
);

export const debugLogEntries = pgTable(
  "debug_log_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: text("category").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    source: text("source"),
    providerKey: text("provider_key"),
    familyId: uuid("family_id").references(() => families.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("debug_log_entries_created_idx").on(t.createdAt),
    index("debug_log_entries_category_idx").on(t.category, t.createdAt)
  ]
);

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    bucketKey: text("bucket_key").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.bucketKey, t.windowStartedAt] })]
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").notNull().default({}),
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("jobs_dedupe_active_idx")
      .on(t.queue, t.dedupeKey)
      .where(sql`${t.status} = 'pending' AND ${t.dedupeKey} IS NOT NULL`),
    index("jobs_claim_idx").on(t.status, t.runAfter),
    index("jobs_recent_idx").on(t.createdAt)
  ]
);

export const cronSchedules = pgTable("cron_schedules", {
  key: text("key").primaryKey(),
  queue: text("queue").notNull(),
  payload: jsonb("payload").notNull().default({}),
  cron: text("cron").notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true)
});

export const recurringSeries = pgTable(
  "recurring_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    merchant: text("merchant"),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    frequency: text("frequency").notNull(),
    config: jsonb("config").notNull().default({}),
    nextDue: date("next_due").notNull(),
    active: boolean("active").notNull().default(true),
    lastPostedEntryId: uuid("last_posted_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("recurring_series_family_idx").on(t.familyId),
    index("recurring_series_due_idx")
      .on(t.active, t.nextDue)
      .where(sql`${t.active}`),
    check(
      "recurring_series_frequency_check",
      sql`${t.frequency} IN ('monthly', 'weekly', 'yearly')`
    )
  ]
);

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    check("budgets_amount_minor_check", sql`${t.amountMinor} > 0`),
    uniqueIndex("budgets_family_category_unique")
      .on(t.familyId, sql`coalesce(${t.categoryId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.active}`)
  ]
);

export const savedFilters = pgTable(
  "saved_filters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    params: jsonb("params").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("saved_filters_user_name_unique").on(t.userId, sql`lower(${t.name})`)]
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    toolCalls: jsonb("tool_calls"),
    toolCallId: text("tool_call_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("chat_messages_family_user_created_idx").on(t.familyId, t.userId, t.createdAt)]
);

export const chatProposals = pgTable(
  "chat_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("create_transaction"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("chat_proposals_user_pending_idx").on(t.userId, t.status, t.expiresAt),
    check(
      "chat_proposals_status_check",
      sql`${t.status} IN ('pending', 'confirmed', 'dismissed', 'expired')`
    )
  ]
);

export const meroShareConnections = pgTable(
  "mero_share_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientId: integer("client_id").notNull(),
    dpCode: text("dp_code").notNull(),
    dpName: text("dp_name").notNull(),
    usernameEncrypted: text("username_encrypted").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("mero_share_connections_family_idx").on(t.familyId)]
);

export const meroShareAccounts = pgTable(
  "mero_share_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => meroShareConnections.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    boid: text("boid").notNull(),
    name: text("name").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("NPR"),
    totalValueMinor: bigint("total_value_minor", { mode: "number" }).notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("mero_share_accounts_connection_boid_unique").on(t.connectionId, t.boid),
    uniqueIndex("mero_share_accounts_account_unique").on(t.accountId)
  ]
);

export const meroShareHoldings = pgTable(
  "mero_share_holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meroShareAccountId: uuid("mero_share_account_id")
      .notNull()
      .references(() => meroShareAccounts.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    quantity: numeric("quantity", { precision: 24, scale: 8 }).notNull(),
    marketPriceMinor: bigint("market_price_minor", { mode: "number" }).notNull().default(0),
    marketValueMinor: bigint("market_value_minor", { mode: "number" }).notNull().default(0),
    costBasisMinor: bigint("cost_basis_minor", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("mero_share_holdings_account_ticker_unique").on(t.meroShareAccountId, t.ticker)
  ]
);

export const meroShareTransactions = pgTable(
  "mero_share_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meroShareAccountId: uuid("mero_share_account_id")
      .notNull()
      .references(() => meroShareAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    quantity: numeric("quantity", { precision: 24, scale: 8 }).notNull(),
    priceMinor: bigint("price_minor", { mode: "number" }),
    estimatedValueMinor: bigint("estimated_value_minor", { mode: "number" }),
    activityLabel: text("activity_label").notNull(),
    occurredOn: date("occurred_on").notNull(),
    description: text("description"),
    transactionCode: text("transaction_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("mero_share_transactions_account_external_unique").on(
      t.meroShareAccountId,
      t.externalId
    )
  ]
);

/**
 * Manual portfolio holdings: user-entered stock positions on valuation-driven
 * (other_asset) accounts, for portfolios that can never arrive via a
 * MeroShare sync (e.g. a demat tracked on someone else's behalf). While an
 * account has holdings, its balance is managed by them: the domain writes a
 * "holdings" valuation entry for today after every mutation and manual
 * valuations are rejected. Quantity is a decimal string (up to 6dp) so the
 * Postgres and cloud SQLite shapes stay identical; per-share prices are
 * minor units.
 */
export const portfolioHoldings = pgTable(
  "portfolio_holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    companyName: text("company_name"),
    quantity: text("quantity").notNull(),
    averageCostMinor: bigint("average_cost_minor", { mode: "number" }),
    /** Quantity (decimal string, ≤6dp) that averageCostMinor applies to. */
    averageCostQuantity: text("average_cost_quantity").notNull().default("0"),
    currentPriceMinor: bigint("current_price_minor", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("portfolio_holdings_account_idx").on(t.accountId),
    uniqueIndex("portfolio_holdings_account_ticker_unique").on(t.accountId, t.ticker)
  ]
);

/**
 * MCP OAuth 2.1 authorization-server tables (read-only AI-agent access).
 * Clients registered via DCR live in oauth_clients; CIMD clients are not
 * stored (their metadata document is the record). oauth_grants is the
 * durable per-connection binding: user + client + ONE household, with the
 * scopes and account ceiling consented to. Codes are single-use and
 * hash-stored; tokens are opaque and hash-stored (sessions/API-key pattern)
 * so revocation is a live row read on every request.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default([]),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  secretHash: text("secret_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    /** Account ceiling consented to; empty means "all accounts the user can
     * currently access" (re-resolved per call, never a snapshot of rights). */
    accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("oauth_grants_user_idx").on(t.userId),
    index("oauth_grants_client_idx").on(t.clientId),
    index("oauth_grants_family_idx").on(t.familyId)
  ]
);

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** Set when the exchange that consumed this code has finished
     * issuing (or failing). Kept as an observability marker. */
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    /** Durable family-invalidation marker: set atomically when a code
     * replay or refresh-token reuse is detected. Token verification and
     * every issuance path check it transactionally, so credentials can
     * never be published — or used — after invalidation, regardless of
     * in-flight races. */
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("oauth_authorization_codes_hash_unique").on(t.codeHash),
    index("oauth_authorization_codes_grant_idx").on(t.grantId)
  ]
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    /** The authorization code that began this token family; refresh
     * rotations copy it forward so code replay / refresh reuse can revoke
     * the whole family. */
    codeId: uuid("code_id").references(() => oauthAuthorizationCodes.id, {
      onDelete: "set null"
    }),
    kind: text("kind").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("oauth_tokens_hash_unique").on(t.tokenHash),
    index("oauth_tokens_grant_idx").on(t.grantId),
    index("oauth_tokens_code_idx").on(t.codeId)
  ]
);

/**
 * Replay claims for `private_key_jwt` client assertions (RFC 7523 §3:
 * a jti must not be reused). Each verified assertion's (client_id, jti)
 * is claimed with an insert against this primary key until the
 * assertion's expiry plus clock tolerance, so a replayed assertion —
 * even a concurrent one — can authenticate at most once.
 */
export const oauthAssertionClaims = pgTable(
  "oauth_assertion_claims",
  {
    clientId: text("client_id").notNull(),
    jti: text("jti").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.jti] }),
    index("oauth_assertion_claims_expires_idx").on(t.expiresAt)
  ]
);

/**
 * Server-side authorization-request records: the consent page renders
 * from one of these, and approval consumes it exactly once. The record —
 * never form fields — is the source of truth for client, redirect_uri,
 * scopes, resource, code challenge, and the household shown at consent,
 * so an approval cannot be transplanted to a different request. The
 * CSRF token is hash-stored and the record is bound to the session that
 * started the flow.
 */
export const oauthAuthorizationRequests = pgTable(
  "oauth_authorization_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    state: text("state"),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("oauth_authorization_requests_user_idx").on(t.userId)]
);

/**
 * SSIS insight tables: a self-contained snapshot of the owner's Siddhartha
 * Systematic Investment Scheme (Siddhartha Capital). Deliberately NOT linked
 * to accounts/entries/balances — this is external reference data with its own
 * lifecycle (import / refresh), shown on the Insights → SSIS page. Only
 * whitelisted upstream fields are stored; the upstream payload's PII
 * (citizenship, PAN, bank/BO identifiers, contacts, OTP) is discarded at
 * import time and never persisted. The one exception is the BO account
 * number in ssis_insight_state, which the user enters explicitly so the
 * server can call the upstream holder endpoints during refresh.
 */
export const ssisPurchases = pgTable(
  "ssis_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    requestNo: text("request_no").notNull(),
    applyDate: date("apply_date").notNull(),
    units: text("units").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    status: text("status").notNull().default(""),
    purchaseNavMinor: bigint("purchase_nav_minor", { mode: "number" }),
    navDate: date("nav_date"),
    schemeName: text("scheme_name"),
    isSip: boolean("is_sip").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("ssis_purchases_family_request_unique").on(t.familyId, t.requestNo),
    index("ssis_purchases_family_idx").on(t.familyId)
  ]
);

export const ssisStatementEntries = pgTable(
  "ssis_statement_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    transNo: text("trans_no").notNull(),
    installmentDate: date("installment_date").notNull(),
    dueDate: date("due_date"),
    actionDate: date("action_date"),
    amountCrMinor: bigint("amount_cr_minor", { mode: "number" }).notNull().default(0),
    amountDrMinor: bigint("amount_dr_minor", { mode: "number" }).notNull().default(0),
    units: text("units"),
    appliedNavMinor: bigint("applied_nav_minor", { mode: "number" }),
    payment: text("payment"),
    otherChargesMinor: bigint("other_charges_minor", { mode: "number" }).notNull().default(0),
    sebonFeeMinor: bigint("sebon_fee_minor", { mode: "number" }).notNull().default(0),
    sipRegNo: text("sip_reg_no"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("ssis_statement_family_trans_unique").on(t.familyId, t.transNo),
    index("ssis_statement_family_idx").on(t.familyId)
  ]
);

export const ssisNavHistory = pgTable(
  "ssis_nav_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    engDate: date("eng_date").notNull(),
    nepDate: text("nep_date").notNull(),
    navMinor: bigint("nav_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("ssis_nav_history_family_date_unique").on(t.familyId, t.engDate),
    index("ssis_nav_history_family_idx").on(t.familyId)
  ]
);

export const ssisInsightState = pgTable("ssis_insight_state", {
  familyId: uuid("family_id")
    .primaryKey()
    .references(() => families.id, { onDelete: "cascade" }),
  holderName: text("holder_name"),
  boAccountNo: text("bo_account_no"),
  // Bumped on every BO-number change. A live refresh captures the value it
  // fetched for and the commit re-checks it, so a refresh started for one
  // holder can never write its rows under another holder's configuration.
  configGeneration: integer("config_generation").notNull().default(0),
  latestNavMinor: bigint("latest_nav_minor", { mode: "number" }),
  latestNavDate: date("latest_nav_date"),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastSource: text("last_source"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
