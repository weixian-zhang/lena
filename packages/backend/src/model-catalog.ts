// Resolves the deployment's real context window from models.dev instead of hardcoding it.
//
// pi-ai ships its own models.dev snapshot, but it's baked at pi's build time and already
// lags behind the deployments we run — so we fetch the catalogue ourselves and cache it.

import { readFile, stat, writeFile } from "node:fs/promises";
import { cacheDir } from "./util/cwd.js";
import {
  CONTEXT_WINDOW_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODELS_DEV_CACHE_TTL_MS,
  MODELS_DEV_FETCH_TIMEOUT_MS,
  MODELS_DEV_PROVIDERS,
  MODELS_DEV_URL,
} from "./util/config.js";

/**
 * Reasoning effort levels Lena uses. models.dev also lists `none`, `xhigh` and `max`;
 * they're filtered out so callers only see levels the agent actually sends.
 */
export type ReasoningEffort = "low" | "medium" | "high";

const EFFORT_LEVELS = ["low", "medium", "high"] as const;

/**
 * A deployment's limits and capabilities, as models.dev reports them.
 *
 * Fields mirror the catalogue verbatim — no derived budget. Callers that need a
 * prompt-side allowance (compaction) subtract their own headroom; what to reserve is
 * their decision, not this module's.
 */
export type ContextWindow = {
  /**
   * models.dev's display name, e.g. `GPT-5.6 Sol`. Falls back to the deployment name
   * when the catalogue can't answer, so it identifies the model but isn't the id sent
   * on the wire — that stays with the caller's Foundry config.
   */
  name: string;
  /** Full window — prompt plus generation. */
  context: number;
  /** Generation cap for one turn. */
  output: number;
  /** Model reasons before answering. */
  reasoning: boolean;
  /** Model accepts a `temperature` parameter. */
  temperature: boolean;
  /** Reasoning effort levels the model supports; empty when it takes none. */
  effort: ReasoningEffort[];
  /** Which tier answered — useful when the numbers look wrong. */
  source: "models.dev" | "default";
};

/** One catalogue entry, trimmed to the fields {@link ContextWindow} exposes. */
type CatalogEntry = Omit<ContextWindow, "source">;

/** Trimmed catalogue: only the providers we search, only the fields we read. */
type ModelCatalog = Record<string, Record<string, CatalogEntry>>;

/** The slice of models.dev's api.json this module reads. */
type ModelsDevResponse = Record<
  string,
  {
    models?: Record<
      string,
      {
        name?: string;
        limit?: { context?: number; output?: number };
        reasoning?: boolean;
        temperature?: boolean;
        reasoning_options?: { type?: string; values?: string[] }[];
      }
    >;
  }
>;

// Versioned: the cached shape changed when capabilities joined the limits, and a
// pre-existing file would otherwise deserialize with those fields missing.
const CACHE_FILE = "models.dev.v2.json";

/**
 * Resolved once by {@link initContextWindow} so {@link getContextWindow} can stay
 * synchronous — compaction checks it inside the agent loop and must not await.
 */
let resolved: ContextWindow | undefined;

/** Same resolution order as loadConfig() in agent.ts. */
function foundryDeploymentNameFromEnv(): string {
  const foundryDeploymentName =
    process.env.MICROSOFT_FOUNDRY_DEPLOYMENT_NAME || process.env.AI_FOUNDRY_DEPLOYMENT_NAME;
  return foundryDeploymentName?.trim() ?? "";
}

/** Keep only the providers we search — 3.3 MB becomes a few KB. */
function trimCatalog(raw: ModelsDevResponse): ModelCatalog {
  const catalog: ModelCatalog = {};
  for (const provider of MODELS_DEV_PROVIDERS) {
    for (const [id, model] of Object.entries(raw[provider]?.models ?? {})) {
      const { context, output } = model.limit ?? {};
      if (typeof context !== "number" || typeof output !== "number") continue;

      const values = model.reasoning_options?.find((o) => o.type === "effort")?.values ?? [];
      (catalog[provider] ??= {})[id] = {
        name: model.name ?? id,
        context,
        output,
        reasoning: model.reasoning === true,
        temperature: model.temperature === true,
        effort: EFFORT_LEVELS.filter((level) => values.includes(level)),
      };
    }
  }
  return catalog;
}

async function isCacheFresh(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs < MODELS_DEV_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/** Returns undefined when the cache is missing or was left corrupt by a killed process. */
async function readCache(path: string): Promise<ModelCatalog | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ModelCatalog;
  } catch {
    return undefined;
  }
}

async function download(): Promise<ModelCatalog> {
  const response = await fetch(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
  return trimCatalog((await response.json()) as ModelsDevResponse);
}

/**
 * Serve the catalogue from disk, re-downloading once the cached copy passes its TTL.
 *
 * Never throws: an unreachable models.dev falls back to the stale cache and then to an
 * empty catalogue, which resolves the window to the conservative default rather than
 * failing startup.
 */
async function loadCatalog(): Promise<ModelCatalog> {
  const path = cacheDir(CACHE_FILE);
  if (await isCacheFresh(path)) {
    const cached = await readCache(path);
    if (cached) return cached;
  }

  try {
    const catalog = await download();
    await writeFile(path, JSON.stringify(catalog), "utf8");
    return catalog;
  } catch (err) {
    const stale = await readCache(path);
    const reason = err instanceof Error ? err.message : err;
    const fallback = stale ? "using the cached catalogue" : "falling back to default limits";
    console.warn(`models.dev refresh failed (${reason}); ${fallback}.`);
    return stale ?? {};
  }
}

/** Exact id match across the searched providers, first hit wins. */
function lookup(catalog: ModelCatalog, foundryDeploymentName: string): CatalogEntry | undefined {
  for (const provider of MODELS_DEV_PROVIDERS) {
    const entry = catalog[provider]?.[foundryDeploymentName];
    if (entry) return entry;
  }
  return undefined;
}

function toContextWindow(entry: CatalogEntry, source: ContextWindow["source"]): ContextWindow {
  return { ...entry, source };
}

/**
 * Resolve the deployment's token budget from models.dev, falling back to the
 * conservative {@link CONTEXT_WINDOW_TOKENS} / {@link MAX_OUTPUT_TOKENS} in config.ts
 * when the catalogue doesn't list the deployment.
 *
 * Call once at startup; {@link getContextWindow} reads the result thereafter.
 *
 * @param override - Foundry deployment name to use instead of the one in the environment.
 */
export async function initContextWindow(override?: string): Promise<ContextWindow> {
  const foundryDeploymentName = override ?? foundryDeploymentNameFromEnv();
  const entry = foundryDeploymentName
    ? lookup(await loadCatalog(), foundryDeploymentName)
    : undefined;

  if (entry) {
    // config.ts caps generation below what the model itself allows.
    const capped = { ...entry, output: Math.min(entry.output, MAX_OUTPUT_TOKENS) };
    resolved = toContextWindow(capped, "models.dev");
    return resolved;
  }

  if (foundryDeploymentName) {
    console.warn(
      `Context window for "${foundryDeploymentName}" not found on models.dev; ` +
        `falling back to the ${CONTEXT_WINDOW_TOKENS.toLocaleString()}-token default ` +
        `in config.ts.`,
    );
  }
  resolved = defaultWindow(foundryDeploymentName);
  return resolved;
}

/**
 * Conservative stand-in when the catalogue can't answer. Capabilities default to off so
 * an unknown deployment gets a plain request — sending `reasoning` or `temperature` to a
 * model that rejects them fails the call outright.
 */
function defaultWindow(foundryDeploymentName: string): ContextWindow {
  return toContextWindow(
    {
      // No catalogue entry, so no display name — fall back to what the deployment is called.
      name: foundryDeploymentName,
      context: CONTEXT_WINDOW_TOKENS,
      output: MAX_OUTPUT_TOKENS,
      reasoning: false,
      temperature: false,
      effort: [],
    },
    "default",
  );
}

/**
 * The resolved limits, for callers that can't await — notably compaction's
 * `shouldCompact`, which runs inside the agent loop.
 *
 * Falls back to the conservative default if {@link initContextWindow} hasn't run, so a
 * missed startup call under-reports the window (compacting early) rather than over-reports
 * it (overflowing the request).
 */
export function getContextWindow(): ContextWindow {
  return resolved ?? defaultWindow(foundryDeploymentNameFromEnv());
}

/** Test seam: drop the resolved limits so the next init re-runs from scratch. */
export function resetContextWindow(): void {
  resolved = undefined;
}
