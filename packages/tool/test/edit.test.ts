import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { EditTool } from "../builtin/file/edit.js";

/** Temp directories made by `makeTempDir`, removed after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("replaces a unique occurrence", async () => {
  const dir = await dirWithFile("f.txt", "const a = 1;\nconst b = 2;\n");

  expect(await new EditTool(dir).execute({ path: "f.txt", old_string: "b = 2", new_string: "b = 3" })).toBe(
    "Replaced 1 occurrence in f.txt.",
  );
  expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
});

test("replaces every occurrence with replace_all", async () => {
  const dir = await dirWithFile("f.txt", "foo foo foo");

  expect(
    await new EditTool(dir).execute({ path: "f.txt", old_string: "foo", new_string: "bar", replace_all: true }),
  ).toBe("Replaced 3 occurrences in f.txt.");
  expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("bar bar bar");
});

test("inserts new_string literally, even with $ patterns", async () => {
  const dir = await dirWithFile("f.txt", "price");

  await new EditTool(dir).execute({ path: "f.txt", old_string: "price", new_string: "$& costs $1" });

  expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("$& costs $1");
});

test("matches CRLF files through LF and writes CRLF back", async () => {
  const dir = await dirWithFile("f.txt", "one\r\ntwo\r\n");

  await new EditTool(dir).execute({ path: "f.txt", old_string: "one\ntwo", new_string: "one\n2" });

  expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("one\r\n2\r\n");
});

test("throws when old_string is missing, ambiguous or unchanged", async () => {
  const tool = new EditTool(await dirWithFile("f.txt", "x x"));

  await expect(tool.execute({ path: "f.txt", old_string: "y", new_string: "z" })).rejects.toThrow(
    'old_string not found in "f.txt".',
  );
  await expect(tool.execute({ path: "f.txt", old_string: "x", new_string: "z" })).rejects.toThrow(
    'old_string occurs 2 times in "f.txt".',
  );
  await expect(tool.execute({ path: "f.txt", old_string: "x", new_string: "x" })).rejects.toThrow(
    "No changes to make",
  );
});

test("throws for a missing file and a directory", async () => {
  const tool = new EditTool(await dirWithFile("f.txt", ""));

  await expect(tool.execute({ path: "missing.txt", old_string: "a", new_string: "b" })).rejects.toThrow(
    '"missing.txt" does not exist.',
  );
  await expect(tool.execute({ path: ".", old_string: "a", new_string: "b" })).rejects.toThrow('"." is not a file.');
});

async function dirWithFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lena-edit-"));
  tempDirs.push(dir);
  await writeFile(join(dir, name), content);
  return dir;
}
