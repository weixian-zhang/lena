import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderPrompt } from "@lena/util/render-prompt";
import { type Static, Type } from "typebox";
import type { Tool, ToolContent } from "../../tool.js";

/** Largest image sent to the model; providers reject bigger ones, and each stays in every later request. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const readMediaDescriptionTemplate = readFileSync(join(import.meta.dirname, "read-media.md"), "utf8").trim();

const paramSchema = Type.Object({
  path: Type.String({
    description:
      "Path to a PNG, JPEG, GIF or WebP image. Relative paths resolve against the working directory the bash tool runs in.",
  }),
});

/** Read an image file and hand it to the model to view. */
export class ReadMediaTool implements Tool<typeof paramSchema> {
  readonly name = "read_media";
  readonly description = renderPrompt(readMediaDescriptionTemplate, { MAX_IMAGE_MEGABYTES: MAX_IMAGE_BYTES / 1024 / 1024 });
  readonly parameters = paramSchema;

  /** `workDir` anchors relative paths; pass the same directory the bash tool runs in. */
  constructor(private readonly workDir: string) {}

  async execute({ path }: Static<typeof paramSchema>): Promise<ToolContent[]> {
    const fullPath = resolve(this.workDir, path);
    const stats = await stat(fullPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`"${path}" does not exist.`);
      throw error;
    });
    if (!stats.isFile()) throw new Error(`"${path}" is not a file.`);
    if (stats.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `"${path}" is ${stats.size} bytes, over the ${MAX_IMAGE_BYTES}-byte image limit. ` +
          "Make a smaller copy with bash and read that instead.",
      );
    }

    const data = await readFile(fullPath);
    const mimeType = detectImageMimeType(data);
    if (mimeType === undefined) {
      throw new Error(
        `"${path}" is not a PNG, JPEG, GIF or WebP image. Use read for text files; ` +
          "convert other image formats to PNG with bash first.",
      );
    }

    return [
      { type: "text", text: `Image ${path} (${mimeType}, ${stats.size} bytes):` },
      { type: "image", data: data.toString("base64"), mimeType },
    ];
  }
}

/** The MIME type from the file's magic bytes, for the formats model providers accept. */
function detectImageMimeType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const ascii = data.toString("latin1", 0, 12);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
