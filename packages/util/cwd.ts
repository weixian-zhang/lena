import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Lena's private root under the user's home directory: `~/.lena`. */
export const LENA_HOME = join(homedir(), ".lena");

/** Re-fetchable data only: `~/.lena/cache`. */
const LENA_CACHE = join(LENA_HOME, "cache");

/**
 * Resolve a path inside Lena's home directory (`~/.lena`).
 */
export function lenaHome(...segments: string[]): string {
  return join(LENA_HOME, ...segments);
}

/**
 * Resolve a path inside Lena's cache directory (`~/.lena/cache`), creating the
 * directory if it doesn't exist yet so callers can write straight to the result.
 *
 * Holds only re-fetchable data, so deleting it costs a round trip and nothing more.
 */
export function cacheDir(...segments: string[]): string {
  mkdirSync(LENA_CACHE, { recursive: true });
  return join(LENA_CACHE, ...segments);
}
