import BetterSqlite3 from "better-sqlite3";
import type { Database } from "./database.js";

export class SqliteDatabase implements Database {
  private readonly db: BetterSqlite3.Database;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
    // WAL for concurrent readers; enforce FKs; wait rather than fail on a busy lock.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(toSqliteParams(params)) as T[];
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowCount: number }> {
    return {
      rowCount: this.db.prepare(sql).run(toSqliteParams(params)).changes,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** SQLite reads `$1` as a parameter named "1", so the array becomes `{ "1": …, "2": … }`. */
function toSqliteParams(params: unknown[]): Record<string, unknown> {
  return Object.fromEntries(
    params.map((value, index) => [String(index + 1), value]),
  );
}
