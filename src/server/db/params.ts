import { usesCloudStorage } from "./dialect";

/**
 * Cloudflare's SQLite-backed Durable Object storage caps a single SQL
 * statement at 100 bound parameters (workerd limit). PostgreSQL accepts far
 * more, so multi-row writes and IN(...) lists keep larger chunks locally.
 */
const CLOUD_SQLITE_PARAM_LIMIT = 100;
const POSTGRES_PARAM_LIMIT = 30_000;

export const sqlParamLimit = usesCloudStorage ? CLOUD_SQLITE_PARAM_LIMIT : POSTGRES_PARAM_LIMIT;

/** Maximum rows a single multi-row INSERT can carry given its column count. */
export function maxRowsPerStatement(columnsPerRow: number): number {
  if (!Number.isInteger(columnsPerRow) || columnsPerRow < 1) {
    throw new RangeError("columnsPerRow must be a positive integer");
  }
  return Math.max(1, Math.floor(sqlParamLimit / columnsPerRow));
}

/**
 * Split rows into chunks whose total bound-parameter count stays within the
 * backend limit. Rows must be uniform (same key set) so each row binds
 * exactly `columnsPerRow` parameters. Never yields an empty chunk.
 */
export function chunkRows<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const size = maxRowsPerStatement(columnsPerRow);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size) as T[]);
  }
  return chunks;
}

/**
 * Split values for an IN(...) list (one bound parameter per value) so each
 * statement stays within the backend limit. Never yields an empty chunk.
 */
export function chunkParams<T>(values: readonly T[]): T[][] {
  return chunkRows(values, 1);
}
