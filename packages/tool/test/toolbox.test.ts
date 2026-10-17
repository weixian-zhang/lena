import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { StandardToolbox } from "../toolbox.js";

/** Temp directories made by `toolboxInTempDir`, removed after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("toJson lists every built-in tool once, in a fixed order", async () => {
  const { toolbox } = await toolboxInTempDir();

  expect(
    JSON.parse(toolbox.toJson()).map((tool: { name: string }) => tool.name),
  ).toEqual([
    "bash",
    "azure_cli_generate",
    "read",
    "read_media",
    "write",
    "edit",
  ]);
});

test("get returns a built-in tool working in the toolbox's workDir", async () => {
  const { toolbox, workDir } = await toolboxInTempDir();
  await writeFile(join(workDir, "notes.txt"), "alpha\n");

  expect(await toolbox.get("read").execute({ path: "notes.txt" })).toContain(
    "1\talpha",
  );
});

test("get throws naming an unknown tool", async () => {
  const { toolbox } = await toolboxInTempDir();

  expect(() => toolbox.get("missing")).toThrow('Unknown tool: "missing".');
});

test("toJson describes each tool without its execute function", async () => {
  const { toolbox } = await toolboxInTempDir();

  for (const tool of JSON.parse(toolbox.toJson())) {
    expect(Object.keys(tool)).toEqual(["name", "description", "parameters"]);
  }
});

/** No tool here runs `bash`, so the Azure login is never used. */
async function toolboxInTempDir(): Promise<{
  toolbox: StandardToolbox;
  workDir: string;
}> {
  const workDir = await mkdtemp(join(tmpdir(), "lena-toolbox-"));
  tempDirs.push(workDir);
  return {
    toolbox: new StandardToolbox(workDir, { kind: "managedIdentity" }),
    workDir,
  };
}
