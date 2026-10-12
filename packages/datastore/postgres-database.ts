import pg from "pg";
import type { Database } from "./database.js";

export class PostgresDatabase implements Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      types: { getTypeParser: postgresTypeParser },
    });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowCount: number }> {
    // pg reports null for statements that change no rows, such as DDL.
    return { rowCount: (await this.pool.query(sql, params)).rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** pg returns BIGINT as a string to avoid precision loss; return a number, and throw where it would lose any. */
const postgresTypeParser = ((oid: number, format?: "text" | "binary") =>
  oid === pg.types.builtins.INT8
    ? parseSafeInteger
    : pg.types.getTypeParser(
        oid,
        format,
      )) as pg.CustomTypesConfig["getTypeParser"];

function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(
      `BIGINT ${value} is outside JavaScript's safe integer range.`,
    );
  return parsed;
}
