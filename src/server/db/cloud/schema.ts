import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  primaryKey,
  text,
  uniqueIndex,
  customType
} from "drizzle-orm/sqlite-core";

// ISO timestamps preserve millisecond precision and compare chronologically in SQLite.
const isoTimestamp = customType<{ data: Date; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.toISOString(),
  fromDriver: (value) => new Date(value)
});

export const families = sqliteTable("families", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("USD"),
  locale: text("locale").notNull().default("en"),
  timezone: text("timezone").notNull().default("Etc/UTC"),
  createdAt: isoTimestamp("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: isoTimestamp("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const users = sqliteTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    accessSubject: text("access_subject").unique(),
    name: text("name").notNull(),
    familyRole: text("family_role").notNull().default("member"),
    platformRole: text("platform_role").notNull().default("user"),
    emailVerifiedAt: isoTimestamp("email_verified_at"),
    removedAt: isoTimestamp("removed_at"),
    preferences: text("preferences", { mode: "json" }).notNull().default({}),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    index("users_family_idx").on(t.familyId)
  ]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    lastUsedAt: isoTimestamp("last_used_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    expiresAt: isoTimestamp("expires_at").notNull()
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)]
);

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: isoTimestamp("expires_at").notNull(),
    usedAt: isoTimestamp("used_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose)]
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: isoTimestamp("last_used_at"),
    revokedAt: isoTimestamp("revoked_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    index("api_keys_family_idx").on(t.familyId),
    index("api_keys_user_idx").on(t.userId),
    uniqueIndex("api_keys_key_hash_unique").on(t.keyHash)
  ]
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    familyRole: text("family_role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: isoTimestamp("expires_at").notNull(),
    acceptedAt: isoTimestamp("accepted_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("invitations_family_idx").on(t.familyId)]
);

export const instanceInvitations = sqliteTable(
  "instance_invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: isoTimestamp("expires_at").notNull(),
    acceptedAt: isoTimestamp("accepted_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("instance_invitations_email_idx").on(t.email)]
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    color: text("color"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("categories_family_name_unique").on(t.familyId, sql`lower(${t.name})`),
    uniqueIndex("categories_family_external_dedupe_idx")
      .on(t.familyId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index("categories_parent_idx").on(t.parentId)
  ]
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("tags_family_name_unique").on(t.familyId, sql`lower(${t.name})`),
    uniqueIndex("tags_family_external_dedupe_idx")
      .on(t.familyId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`)
  ]
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    balanceTracking: text("balance_tracking").notNull().default("valuation"),
    subtype: text("subtype"),
    name: text("name").notNull(),
    institution: text("institution"),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("active"),
    includedInReports: integer("included_in_reports", { mode: "boolean" }).notNull().default(true),
    openingBalanceMinor: integer("opening_balance_minor").notNull().default(0),
    openedOn: text("opened_on").notNull(),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    index("accounts_family_idx").on(t.familyId),
    uniqueIndex("accounts_family_external_dedupe_idx")
      .on(t.familyId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`)
  ]
);

export const accountShares = sqliteTable(
  "account_shares",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [uniqueIndex("account_shares_unique").on(t.accountId, t.userId)]
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    parentEntryId: text("parent_entry_id"),
    recurringSeriesId: text("recurring_series_id").references(() => recurringSeries.id, {
      onDelete: "set null"
    }),
    date: text("date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    name: text("name").notNull(),
    notes: text("notes"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    entryableType: text("entryable_type").notNull(),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
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

export const transactions = sqliteTable("transactions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  entryId: text("entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
  merchant: text("merchant"),
  transferId: text("transfer_id")
});

export const valuations = sqliteTable("valuations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  entryId: text("entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("current")
});

export const transfers = sqliteTable("transfers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  outflowEntryId: text("outflow_entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  inflowEntryId: text("inflow_entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("confirmed"),
  createdAt: isoTimestamp("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" })
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.tagId] }),
    index("transaction_tags_tag_idx").on(t.tagId)
  ]
);

export const exchangeRates = sqliteTable(
  "exchange_rates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    baseCurrency: text("base_currency").notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    rate: text("rate").notNull(),
    quotedOn: text("quoted_on").notNull(),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("exchange_rates_pair_date_unique").on(t.baseCurrency, t.quoteCurrency, t.quotedOn),
    index("exchange_rates_pair_date_idx").on(t.baseCurrency, t.quoteCurrency, t.quotedOn)
  ]
);

export const balances = sqliteTable(
  "balances",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    asOf: text("as_of").notNull(),
    balanceMinor: integer("balance_minor").notNull(),
    currency: text("currency").notNull()
  },
  (t) => [primaryKey({ columns: [t.accountId, t.asOf] })]
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id").references(() => families.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: text("metadata", { mode: "json" }).notNull().default({}),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("audit_events_family_created_idx").on(t.familyId, t.createdAt)]
);

export const debugLogEntries = sqliteTable(
  "debug_log_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    category: text("category").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    source: text("source"),
    providerKey: text("provider_key"),
    familyId: text("family_id").references(() => families.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    metadata: text("metadata", { mode: "json" }).notNull().default({}),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    index("debug_log_entries_created_idx").on(t.createdAt),
    index("debug_log_entries_category_idx").on(t.category, t.createdAt)
  ]
);

export const featureFlags = sqliteTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  description: text("description").notNull().default(""),
  updatedAt: isoTimestamp("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    bucketKey: text("bucket_key").notNull(),
    windowStartedAt: isoTimestamp("window_started_at").notNull(),
    count: integer("count").notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.bucketKey, t.windowStartedAt] })]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    queue: text("queue").notNull(),
    payload: text("payload", { mode: "json" }).notNull().default({}),
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: isoTimestamp("run_after")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    lockedAt: isoTimestamp("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    completedAt: isoTimestamp("completed_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("jobs_dedupe_active_idx")
      .on(t.queue, t.dedupeKey)
      .where(sql`${t.status} = 'pending' AND ${t.dedupeKey} IS NOT NULL`),
    index("jobs_claim_idx").on(t.status, t.runAfter),
    index("jobs_recent_idx").on(t.createdAt)
  ]
);

export const cronSchedules = sqliteTable("cron_schedules", {
  key: text("key").primaryKey(),
  queue: text("queue").notNull(),
  payload: text("payload", { mode: "json" }).notNull().default({}),
  cron: text("cron").notNull(),
  nextRunAt: isoTimestamp("next_run_at").notNull(),
  lastRunAt: isoTimestamp("last_run_at"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true)
});

export const recurringSeries = sqliteTable(
  "recurring_series",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    merchant: text("merchant"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    frequency: text("frequency").notNull(),
    config: text("config", { mode: "json" }).notNull().default({}),
    nextDue: text("next_due").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastPostedEntryId: text("last_posted_entry_id"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
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

export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "cascade" }),
    amountMinor: integer("amount_minor").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    check("budgets_amount_minor_check", sql`${t.amountMinor} > 0`),
    uniqueIndex("budgets_family_category_unique")
      .on(t.familyId, sql`coalesce(${t.categoryId}, '00000000-0000-0000-0000-000000000000')`)
      .where(sql`${t.active}`)
  ]
);

export const savedFilters = sqliteTable(
  "saved_filters",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    params: text("params", { mode: "json" }).notNull().default({}),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [uniqueIndex("saved_filters_user_name_unique").on(t.userId, sql`lower(${t.name})`)]
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    toolCalls: text("tool_calls", { mode: "json" }),
    toolCallId: text("tool_call_id"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("chat_messages_family_user_created_idx").on(t.familyId, t.userId, t.createdAt)]
);

export const chatProposals = sqliteTable(
  "chat_proposals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("create_transaction"),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: isoTimestamp("expires_at").notNull(),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    index("chat_proposals_user_pending_idx").on(t.userId, t.status, t.expiresAt),
    check(
      "chat_proposals_status_check",
      sql`${t.status} IN ('pending', 'confirmed', 'dismissed', 'expired')`
    )
  ]
);

export const meroShareConnections = sqliteTable(
  "mero_share_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientId: integer("client_id").notNull(),
    dpCode: text("dp_code").notNull(),
    dpName: text("dp_name").notNull(),
    usernameEncrypted: text("username_encrypted").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    lastSyncedAt: isoTimestamp("last_synced_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("mero_share_connections_family_idx").on(t.familyId)]
);

export const meroShareAccounts = sqliteTable(
  "mero_share_accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    connectionId: text("connection_id")
      .notNull()
      .references(() => meroShareConnections.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    boid: text("boid").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull().default("NPR"),
    totalValueMinor: integer("total_value_minor").notNull().default(0),
    lastSyncedAt: isoTimestamp("last_synced_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("mero_share_accounts_connection_boid_unique").on(t.connectionId, t.boid),
    uniqueIndex("mero_share_accounts_account_unique").on(t.accountId)
  ]
);

export const meroShareHoldings = sqliteTable(
  "mero_share_holdings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    meroShareAccountId: text("mero_share_account_id")
      .notNull()
      .references(() => meroShareAccounts.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    quantity: text("quantity").notNull(),
    marketPriceMinor: integer("market_price_minor").notNull().default(0),
    marketValueMinor: integer("market_value_minor").notNull().default(0),
    costBasisMinor: integer("cost_basis_minor"),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("mero_share_holdings_account_ticker_unique").on(t.meroShareAccountId, t.ticker)
  ]
);

export const meroShareTransactions = sqliteTable(
  "mero_share_transactions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    meroShareAccountId: text("mero_share_account_id")
      .notNull()
      .references(() => meroShareAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    quantity: text("quantity").notNull(),
    priceMinor: integer("price_minor"),
    estimatedValueMinor: integer("estimated_value_minor"),
    activityLabel: text("activity_label").notNull(),
    occurredOn: text("occurred_on").notNull(),
    description: text("description"),
    transactionCode: text("transaction_code"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("mero_share_transactions_account_external_unique").on(
      t.meroShareAccountId,
      t.externalId
    )
  ]
);

/**
 * Manual portfolio holdings (cloud/SQLite mirror of the Postgres table):
 * user-entered stock positions on other_asset accounts. While an account
 * has holdings, its balance is managed by them via a daily "holdings"
 * valuation entry, and manual valuations are rejected.
 */
export const portfolioHoldings = sqliteTable(
  "portfolio_holdings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    companyName: text("company_name"),
    quantity: text("quantity").notNull(),
    averageCostMinor: integer("average_cost_minor"),
    /** Quantity (decimal string, ≤6dp) that averageCostMinor applies to. */
    averageCostQuantity: text("average_cost_quantity").notNull().default("0"),
    currentPriceMinor: integer("current_price_minor"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    index("portfolio_holdings_account_idx").on(t.accountId),
    uniqueIndex("portfolio_holdings_account_ticker_unique").on(t.accountId, t.ticker)
  ]
);

/**
 * MCP OAuth 2.1 authorization-server tables — cloud mirror of the Postgres
 * schema (see postgres-schema.ts for the design notes).
 */
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull().default([]),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  secretHash: text("secret_hash"),
  createdAt: isoTimestamp("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: isoTimestamp("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    accountIds: text("account_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    expiresAt: isoTimestamp("expires_at").notNull(),
    lastUsedAt: isoTimestamp("last_used_at"),
    revokedAt: isoTimestamp("revoked_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoTimestamp("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    index("oauth_grants_user_idx").on(t.userId),
    index("oauth_grants_client_idx").on(t.clientId),
    index("oauth_grants_family_idx").on(t.familyId)
  ]
);

export const oauthAuthorizationCodes = sqliteTable(
  "oauth_authorization_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    codeHash: text("code_hash").notNull().unique(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    usedAt: isoTimestamp("used_at"),
    issuedAt: isoTimestamp("issued_at"),
    invalidatedAt: isoTimestamp("invalidated_at"),
    expiresAt: isoTimestamp("expires_at").notNull(),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("oauth_authorization_codes_hash_unique").on(t.codeHash),
    index("oauth_authorization_codes_grant_idx").on(t.grantId)
  ]
);

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tokenHash: text("token_hash").notNull().unique(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    codeId: text("code_id").references(() => oauthAuthorizationCodes.id, {
      onDelete: "set null"
    }),
    kind: text("kind").notNull(),
    resource: text("resource").notNull(),
    expiresAt: isoTimestamp("expires_at").notNull(),
    revokedAt: isoTimestamp("revoked_at"),
    replacedById: text("replaced_by_id"),
    lastUsedAt: isoTimestamp("last_used_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    uniqueIndex("oauth_tokens_hash_unique").on(t.tokenHash),
    index("oauth_tokens_grant_idx").on(t.grantId),
    index("oauth_tokens_code_idx").on(t.codeId)
  ]
);

/** Cloud mirror of oauth_assertion_claims (see postgres-schema.ts). */
export const oauthAssertionClaims = sqliteTable(
  "oauth_assertion_claims",
  {
    clientId: text("client_id").notNull(),
    jti: text("jti").notNull(),
    expiresAt: isoTimestamp("expires_at").notNull(),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.jti] }),
    index("oauth_assertion_claims_expires_idx").on(t.expiresAt)
  ]
);

/** Cloud mirror of oauth_authorization_requests (see postgres-schema.ts). */
export const oauthAuthorizationRequests = sqliteTable(
  "oauth_authorization_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    state: text("state"),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: isoTimestamp("expires_at").notNull(),
    consumedAt: isoTimestamp("consumed_at"),
    createdAt: isoTimestamp("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => [index("oauth_authorization_requests_user_idx").on(t.userId)]
);
