import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { Tool } from "../../tool.js";

const paramSchema = Type.Object({
  path: Type.String({
    description:
      "Path to the file to create or overwrite. Relative paths resolve against the working directory the " +
      "bash tool runs in. Missing parent directories are created.",
  }),
  content: Type.String({ description: "The full file content, written exactly as given." }),
});

/** Create or overwrite a UTF-8 text file, creating missing parent directories. */
export class WriteTool implements Tool<typeof paramSchema> {
  readonly name = "write";
  readonly description =
    "Write a text file, replacing it entirely if it exists. Missing parent directories are created. " +
    "Pass the complete content — this does not edit or append.";
  readonly parameters = paramSchema;

  /** `workDir` anchors relative paths; pass the same directory the bash tool runs in. */
  constructor(private readonly workDir: string) {}

  async execute({ path, content }: Static<typeof paramSchema>): Promise<string> {
    const fullPath = resolve(this.workDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}.`;
  }
}
