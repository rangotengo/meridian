import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const usesCloudStorage =
  (process.env.DATABASE_BACKEND ?? (process.env.DATABASE_URL ? "postgres" : "cloud-sqlite")) ===
  "cloud-sqlite";
export const databaseNow = usesCloudStorage
  ? sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  : sql`now()`;

/**
 * A timestamp for "this write is happening now", evaluated when the
 * statement executes — NOT PostgreSQL's now(), which is the transaction
 * START time (and is what the created_at column defaults use). A writer
 * that began its transaction before acquiring a per-account lock would
 * otherwise be stamped earlier than a competitor that committed in the
 * meantime, and lose same-day valuation precedence despite writing last.
 * Valuation-entry writers stamp created_at with this value explicitly.
 * SQLite has no transaction-start timestamp — its 'now' is already
 * statement time — so a JS Date at the moment of the write is the
 * equivalent there (the Durable Object serializes writers).
 */
export function statementTimestamp(): Date | SQL {
  return usesCloudStorage ? new Date() : sql`clock_timestamp()`;
}
export const rowLock = usesCloudStorage ? sql`` : sql`FOR UPDATE SKIP LOCKED`;

export function dateDistance(left: SQL, right: string): SQL {
  return usesCloudStorage
    ? sql`abs(julianday(${left}) - julianday(${right}))`
    : sql`abs(${left} - CAST(${right} AS date))`;
}

export function caseInsensitiveLike(column: SQLWrapper, pattern: string): SQL {
  return sql`lower(${column}) LIKE lower(${pattern})`;
}

export function mergeJson(column: SQL, patch: Record<string, unknown>): SQL {
  return usesCloudStorage
    ? sql`json_patch(${column}, ${JSON.stringify(patch)})`
    : sql`${column} || CAST(${JSON.stringify(patch)} AS jsonb)`;
}
