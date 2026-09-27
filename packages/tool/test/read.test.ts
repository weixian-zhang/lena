import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_LINE_LENGTH, MAX_LINES, ReadTool } from "../builtin/file/read.js";

/** Temp directories made by `toolWithFile`, removed after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("reads a relative path as numbered lines with a status line", async () => {
  const tool = await toolWithFile("notes.txt", "alpha\r\nbeta\n");

  expect(await tool.execute({ path: "notes.txt" })).toBe(
    "1\talpha\n2\tbeta\n\n[2 lines read from line 1. Total lines in file: 2.]",
  );
});

test("pages with line_offset and n_lines and says where to continue", async () => {
  const tool = await toolWithFile("f.txt", "a\nb\nc\nd\n");

  expect(await tool.execute({ path: "f.txt", line_offset: 2, n_lines: 2 })).toBe(
    "2\tb\n3\tc\n\n[2 lines read from line 2. Total lines in file: 4. Continue with line_offset 4.]",
  );
});

test("caps a call at MAX_LINES", async () => {
  const tool = await toolWithFile("big.txt", "x\n".repeat(MAX_LINES + 5));

  expect(await tool.execute({ path: "big.txt" })).toContain(`Continue with line_offset ${MAX_LINES + 1}.`);
});

test("cuts overlong lines and names them", async () => {
  const tool = await toolWithFile("wide.txt", "y".repeat(MAX_LINE_LENGTH + 10));

  const output = await tool.execute({ path: "wide.txt" });

  expect(output.split("\n")[0]).toBe(`1\t${"y".repeat(MAX_LINE_LENGTH - 3)}...`);
  expect(output).toContain(`Lines 1 were cut at ${MAX_LINE_LENGTH} characters.`);
});

test("reports an offset past the end", async () => {
  const tool = await toolWithFile("f.txt", "a\n");

  expect(await tool.execute({ path: "f.txt", line_offset: 5 })).toBe("[No lines read. Total lines in file: 1.]");
});

test("throws for a missing file, a directory and a binary file", async () => {
  const tool = await toolWithFile("bin.dat", Buffer.from([0x00, 0xff, 0x10]));

  await expect(tool.execute({ path: "missing.txt" })).rejects.toThrow('"missing.txt" does not exist.');
  await expect(tool.execute({ path: "." })).rejects.toThrow('"." is not a file.');
  await expect(tool.execute({ path: "bin.dat" })).rejects.toThrow('"bin.dat" is not UTF-8 text.');
});

async function toolWithFile(name: string, content: string | Buffer): Promise<ReadTool> {
  const dir = await mkdtemp(join(tmpdir(), "lena-read-"));
  tempDirs.push(dir);
  await writeFile(join(dir, name), content);
  return new ReadTool(dir);
}
