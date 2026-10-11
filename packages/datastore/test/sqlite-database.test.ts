import { afterEach, expect, test } from "vitest";
import {
  openDatabase,
  SqliteDatabase,
  type Database,
  type DatabaseMode,
} from "../index.js";

const opened: Database[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((database) => database.close()));
});

test("LOCAL mode opens SQLite", () => {
  expect(
    openDatabase({ mode: "LOCAL", connection: ":memory:" }),
  ).toBeInstanceOf(SqliteDatabase);
});

test("an unknown mode throws naming it", () => {
  expect(() =>
    openDatabase({ mode: "REMOTE" as DatabaseMode, connection: ":memory:" }),
  ).toThrow('Unknown database mode: "REMOTE". Expected "LOCAL" or "CLOUD".');
});

test("execute runs DDL and writes, and query reads the rows back", async () => {
  const database = await databaseWithItemsTable();
  await database.execute("INSERT INTO items (id, name) VALUES ($1, $2)", [
    1,
    "alpha",
  ]);

  expect(await database.query("SELECT id, name FROM items")).toEqual([
    { id: 1, name: "alpha" },
  ]);
});

test("$n placeholders bind by number, so one parameter can appear twice", async () => {
  const database = openSqlite();

  expect(
    await database.query("SELECT $2 AS second, $1 AS first, $1 AS again", [
      "a",
      "b",
    ]),
  ).toEqual([{ second: "b", first: "a", again: "a" }]);
});

test("a $n inside a string literal stays text", async () => {
  const database = openSqlite();

  expect(
    await database.query("SELECT '$1' AS literal, $1 AS bound", ["x"]),
  ).toEqual([{ literal: "$1", bound: "x" }]);
});

test("execute reports how many rows a statement changed", async () => {
  const database = await databaseWithItemsTable();
  await database.execute(
    "INSERT INTO items (id, name) VALUES ($1, $2), ($3, $4)",
    [1, "alpha", 2, "beta"],
  );

  expect(
    await database.execute("UPDATE items SET name = $1", ["renamed"]),
  ).toEqual({ rowCount: 2 });
  expect(
    await database.execute("DELETE FROM items WHERE id = $1", [99]),
  ).toEqual({ rowCount: 0 });
});

test("a missing parameter throws", async () => {
  const database = openSqlite();

  await expect(
    database.query("SELECT $1 AS a, $2 AS b", ["x"]),
  ).rejects.toThrow('Missing named parameter "2"');
});

function openSqlite(): Database {
  const database = openDatabase({ mode: "LOCAL", connection: ":memory:" });
  opened.push(database);
  return database;
}

async function databaseWithItemsTable(): Promise<Database> {
  const database = openSqlite();
  await database.execute(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  );
  return database;
}
