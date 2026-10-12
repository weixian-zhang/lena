/** Which backend to open: SQLite on the local machine, PostgreSQL in the cloud. */
export type DatabaseMode = "LOCAL" | "CLOUD";

/**
 * Runs SQL against SQLite or PostgreSQL without knowing any module's tables. Placeholders are
 * written `$1`, `$2`, … for both backends.
 */
export interface Database {
  /** Rows returned by one statement (a `SELECT`, or a write with `RETURNING`). */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs one statement, DDL included, and reports how many rows it changed. */
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  close(): Promise<void>;
}
