import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_IMAGE_BYTES, ReadMediaTool } from "../builtin/file/read-media.js";

/** Temp directories made by `toolWithFile`, removed after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("returns a PNG as a base64 image part after a caption", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
  const tool = await toolWithFile("shot.png", png);

  expect(await tool.execute({ path: "shot.png" })).toEqual([
    { type: "text", text: `Image shot.png (image/png, ${png.length} bytes):` },
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
  ]);
});

test("detects JPEG, GIF and WebP from their bytes, not the extension", async () => {
  const tool = await toolWithFile("a.bin", Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const dir = tempDirs[0]!;
  await writeFile(join(dir, "b.bin"), "GIF89a....");
  await writeFile(join(dir, "c.bin"), "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");

  expect(await mimeTypeOf(tool, "a.bin")).toBe("image/jpeg");
  expect(await mimeTypeOf(tool, "b.bin")).toBe("image/gif");
  expect(await mimeTypeOf(tool, "c.bin")).toBe("image/webp");
});

test("throws for text, unsupported formats and oversized files", async () => {
  const tool = await toolWithFile("notes.png", "just text");
  await writeFile(join(tempDirs[0]!, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));

  await expect(tool.execute({ path: "notes.png" })).rejects.toThrow('"notes.png" is not a PNG, JPEG, GIF or WebP image.');
  await expect(tool.execute({ path: "big.png" })).rejects.toThrow("over the 5242880-byte image limit");
});

test("throws for a missing file and a directory", async () => {
  const tool = await toolWithFile("x.png", "");

  await expect(tool.execute({ path: "missing.png" })).rejects.toThrow('"missing.png" does not exist.');
  await expect(tool.execute({ path: "." })).rejects.toThrow('"." is not a file.');
});

test("the description fills the size limit", () => {
  expect(new ReadMediaTool(tmpdir()).description).toContain("up to 5 MB");
});

async function toolWithFile(name: string, content: string | Buffer): Promise<ReadMediaTool> {
  const dir = await mkdtemp(join(tmpdir(), "lena-read-media-"));
  tempDirs.push(dir);
  await writeFile(join(dir, name), content);
  return new ReadMediaTool(dir);
}

async function mimeTypeOf(tool: ReadMediaTool, path: string): Promise<string | undefined> {
  const image = (await tool.execute({ path })).find((part) => part.type === "image");
  return image?.mimeType;
}
