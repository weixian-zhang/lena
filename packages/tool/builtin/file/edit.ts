import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { Tool } from "../../tool.js";

const editDescription = readFileSync(join(import.meta.dirname, "edit.md"), "utf8").trim();

const paramSchema = Type.Object({
  path: Type.String({
    description: "Path to the text file to edit. Relative paths resolve against the working directory the bash tool runs in.",
  }),
  old_string: Type.String({
    minLength: 1,
    description: "Exact text to replace, as shown by `read` but without the line-number prefix.",
  }),
  new_string: Type.String({ description: "The replacement text." }),
  replace_all: Type.Optional(
    Type.Boolean({ description: "Set true only when every occurrence of old_string should be replaced." }),
  ),
});

/** Replace exact text in an existing file; `old_string` must be unique unless `replace_all` is set. */
export class EditTool implements Tool<typeof paramSchema> {
  readonly name = "edit";
  readonly description = editDescription;
  readonly parameters = paramSchema;

  /** `workDir` anchors relative paths; pass the same directory the bash tool runs in. */
  constructor(private readonly workDir: string) {}

  async execute({ path, old_string, new_string, replace_all = false }: Static<typeof paramSchema>): Promise<string> {
    if (old_string === new_string) throw new Error("No changes to make: old_string and new_string are the same.");

    const fullPath = resolve(this.workDir, path);
    const raw = await readFile(fullPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`"${path}" does not exist.`);
      if (error.code === "EISDIR") throw new Error(`"${path}" is not a file.`);
      throw error;
    });
    // `read` shows CRLF as LF, so match against that view and restore CRLF on write.
    const content = raw.replaceAll("\r\n", "\n");
    const usesCrlf = content !== raw;

    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      throw new Error(`old_string not found in "${path}". The file may have changed; read it again.`);
    }
    if (occurrences > 1 && !replace_all) {
      throw new Error(
        `old_string occurs ${occurrences} times in "${path}". Add surrounding context to make it unique, ` +
          "or set replace_all to change every occurrence.",
      );
    }

    const edited = replace_all
      ? content.replaceAll(old_string, () => new_string)
      : content.replace(old_string, () => new_string);
    await writeFile(fullPath, usesCrlf ? edited.replaceAll("\n", "\r\n") : edited, "utf8");
    return `Replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${path}.`;
  }
}
