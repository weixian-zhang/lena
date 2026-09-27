import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderPrompt } from "@lena/util/render-prompt";
import { type Static, Type } from "typebox";
import type { Tool } from "../../tool.js";

const readDescriptionTemplate = readFileSync(join(import.meta.dirname, "read.md"), "utf8").trim();

/** Most lines one call returns; the model pages on with `line_offset`. */
export const MAX_LINES = 1000;
/** Longer lines are cut so one minified line can't flood the context. */
export const MAX_LINE_LENGTH = 2000;
/** Byte cap on the rendered output, matching the bash tool's cap. */
export const MAX_BYTES = 100_000;

const paramSchema = Type.Object({
  path: Type.String({
    description: "Path to a text file. Relative paths resolve against the working directory the bash tool runs in.",
  }),
  line_offset: Type.Optional(
    Type.Integer({ minimum: 1, description: "The line number to start reading from. Omit to start at line 1." }),
  ),
  n_lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `The number of lines to read. Omit to read up to the cap of ${MAX_LINES} lines.`,
    }),
  ),
});

/** Read a UTF-8 text file as numbered lines, capped by line count, line length and bytes. */
export class ReadTool implements Tool<typeof paramSchema> {
  readonly name = "read";
  readonly description = renderPrompt(readDescriptionTemplate, {
    MAX_LINES,
    MAX_BYTES_KB: MAX_BYTES / 1000,
    MAX_LINE_LENGTH,
  });
  readonly parameters = paramSchema;

  /** `workDir` anchors relative paths; pass the same directory the bash tool runs in. */
  constructor(private readonly workDir: string) {}

  async execute({ path, line_offset = 1, n_lines = MAX_LINES }: Static<typeof paramSchema>): Promise<string> {
    const fullPath = resolve(this.workDir, path);
    const stats = await stat(fullPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`"${path}" does not exist.`);
      throw error;
    });
    if (!stats.isFile()) throw new Error(`"${path}" is not a file.`);

    const text = decodeUtf8Text(await readFile(fullPath));
    if (text === undefined) throw new Error(`"${path}" is not UTF-8 text. Use bash for binary files.`);

    const lines = splitLines(text);
    const wanted = lines.slice(line_offset - 1, line_offset - 1 + Math.min(n_lines, MAX_LINES));
    const rendered: string[] = [];
    const truncatedLineNumbers: number[] = [];
    let bytes = 0;
    for (const [index, line] of wanted.entries()) {
      const lineNumber = line_offset + index;
      const cut = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH - 3) + "..." : line;
      const entry = `${lineNumber}\t${cut}`;
      bytes += Buffer.byteLength(entry) + 1;
      if (rendered.length > 0 && bytes > MAX_BYTES) break;
      rendered.push(entry);
      if (cut !== line) truncatedLineNumbers.push(lineNumber);
    }

    const status = readStatus(rendered.length, line_offset, lines.length, truncatedLineNumbers);
    return rendered.length > 0 ? `${rendered.join("\n")}\n\n${status}` : status;
  }
}

/** The file as text, or `undefined` when it isn't valid UTF-8 or holds NUL bytes (binary). */
function decodeUtf8Text(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Lines without their terminators; a trailing newline does not start an extra empty line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The status line telling the model what it got and where the file ends. */
function readStatus(lineCount: number, startLine: number, totalLines: number, truncated: number[]): string {
  const parts = [
    lineCount > 0 ? `[${lineCount} lines read from line ${startLine}.` : "[No lines read.",
    `Total lines in file: ${totalLines}.`,
  ];
  const lastLineRead = startLine + lineCount - 1;
  if (lineCount > 0 && lastLineRead < totalLines) parts.push(`Continue with line_offset ${lastLineRead + 1}.`);
  if (truncated.length > 0) parts.push(`Lines ${truncated.join(", ")} were cut at ${MAX_LINE_LENGTH} characters.`);
  return parts.join(" ") + "]";
}
