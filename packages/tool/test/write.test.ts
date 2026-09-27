import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WriteTool } from "../builtin/file/write.js";

/** Temp directories made by `makeTempDir`, removed after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("writes a relative path and reports the UTF-8 byte count", async () => {
  const dir = await makeTempDir();

  expect(await new WriteTool(dir).execute({ path: "notes.txt", content: "héllo\n" })).toBe(
    "Wrote 7 bytes to notes.txt.",
  );
  expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("héllo\n");
});

test("creates missing parent directories", async () => {
  const dir = await makeTempDir();

  await new WriteTool(dir).execute({ path: "a/b/c.txt", content: "deep" });

  expect(await readFile(join(dir, "a/b/c.txt"), "utf8")).toBe("deep");
});

test("replaces an existing file entirely", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, "f.txt"), "old content that is longer");

  await new WriteTool(dir).execute({ path: "f.txt", content: "new" });

  expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("new");
});

test("throws when the path is a directory", async () => {
  const dir = await makeTempDir();

  await expect(new WriteTool(dir).execute({ path: ".", content: "x" })).rejects.toThrow("EISDIR");
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lena-write-"));
  tempDirs.push(dir);
  return dir;
}
