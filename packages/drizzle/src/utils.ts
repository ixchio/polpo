/**
 * Dialect flag — determines JSON serialization strategy.
 * - "pg": columns may be jsonb (native objects) or text (JSON strings).
 * - "sqlite": TEXT columns always store JSON strings.
 *
 * Both serialize/deserialize handle strings safely regardless of dialect,
 * so text columns with JSON content work on both PG and SQLite.
 */
export type Dialect = "pg" | "sqlite";

/** Serialize a value for storage in a JSON/text column. Always stringifies. */
export function serializeJson(value: unknown, _dialect: Dialect): unknown {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Deserialize a value read from a JSON/text column. Parses strings, passes objects through. */
export function deserializeJson<T>(value: unknown, fallback: T, _dialect: Dialect): T {
  if (value === undefined || value === null) return fallback;
  // Already a parsed object (e.g. from a jsonb column)
  if (typeof value === "object") return value as T;
  // String from a text column — parse it
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return fallback;
}

/**
 * Extract the number of affected rows from a Drizzle mutation result.
 *
 * Different drivers return the row count under different property names:
 * - better-sqlite3 (drizzle-orm/better-sqlite3): `{ changes: N }`
 * - node-postgres   (drizzle-orm/node-postgres):  `{ rowCount: N }`
 * - postgres.js     (drizzle-orm/postgres-js):    Result extends Array with `.count` property
 *
 * This helper normalises all of them into a single number.
 */
export function extractAffectedRows(result: any): number {
  if (result == null) return 0;
  return result.rowsAffected ?? result.rowCount ?? result.changes ?? result.count ?? 0;
}

/**
 * Detect a unique-constraint violation across all supported drivers.
 *
 * - SQLite (better-sqlite3): error.message contains "UNIQUE" or "unique"
 * - node-postgres:           error.code === "23505"
 * - postgres.js:             throws PostgresError with code "23505",
 *                            but Drizzle wraps it in DrizzleQueryError (original is on `err.cause`)
 */
export function isUniqueViolation(err: any): boolean {
  // Direct message check (SQLite, raw PG errors)
  if (err?.message?.includes("unique") || err?.message?.includes("UNIQUE")) return true;
  // Direct PG error code (node-postgres or raw postgres.js)
  if (err?.code === "23505") return true;
  // Drizzle wraps driver errors as `cause` on DrizzleQueryError
  const cause = err?.cause;
  if (cause?.code === "23505") return true;
  if (cause?.message?.includes("unique") || cause?.message?.includes("UNIQUE")) return true;
  return false;
}
