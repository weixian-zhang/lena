import type { Database, DatabaseMode } from "./database.js";
import { PostgresDatabase } from "./postgres-database.js";
import { SqliteDatabase } from "./sqlite-database.js";

export type { Database, DatabaseMode } from "./database.js";
export { PostgresDatabase } from "./postgres-database.js";
export { SqliteDatabase } from "./sqlite-database.js";

/** Opens SQLite for `LOCAL` (`connection` is a file path) or PostgreSQL for `CLOUD` (a connection string). */
export function openDatabase(options: {
  mode: DatabaseMode;
  connection: string;
}): Database {
  switch (options.mode) {
    case "LOCAL":
      return new SqliteDatabase(options.connection);
    case "CLOUD":
      return new PostgresDatabase(options.connection);
    default:
      throw new Error(
        `Unknown database mode: "${String(options.mode)}". Expected "LOCAL" or "CLOUD".`,
      );
  }
}
