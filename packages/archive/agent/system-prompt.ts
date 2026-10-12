import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lena's system prompt, authored as Markdown beside this module. */
export const SYSTEM_PROMPT = readFileSync(
  join(import.meta.dirname, "prompt", "system-prompt.md"),
  "utf8",
).trim();
