import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getContextWindow,
  initContextWindow,
  resetContextWindow,
} from "../src/model-catalog.js";

// Offline unit test: every models.dev response is stubbed, so this never hits the network,
// and the cache directory is redirected to a temp dir so it never touches ~/.lena.

const mocks = vi.hoisted(() => ({ cacheDir: "" }));

vi.mock("../src/util/cwd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util/cwd.js")>()),
  cacheDir: (...segments: string[]) => join(mocks.cacheDir, ...segments),
}));

/** Shape of the real api.json, cut down to the providers and fields the module reads. */
const SOL = {
  name: "GPT-5.6 Sol",
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  reasoning: true,
  temperature: false,
  // The real catalogue lists levels Lena never sends; they must be filtered out.
  reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
};

const CATALOG = {
  azure: {
    models: {
      "gpt-5.6-sol": SOL,
      "gpt-5": { name: "GPT-5", limit: { context: 400_000, output: 128_000 } },
    },
  },
  "azure-cognitive-services": {
    models: { "gpt-5.6-sol": { ...SOL, limit: { context: 1_050_000, output: 128_000 } } },
  },
  openai: {
    // Deliberately disagrees with azure so provider ordering is observable.
    models: { "gpt-5.6-sol": { ...SOL, limit: { context: 372_000, output: 128_000 } } },
  },
  // Not searched — must be dropped from the cached catalogue.
  xpersona: { models: { "gpt-5.6-sol": { limit: { context: 1, output: 1 } } } },
};

/** Must match CACHE_FILE in model-catalog.ts. */
const CACHE_FILE = "models.dev.v2.json";

const ENV_KEYS = ["MICROSOFT_FOUNDRY_DEPLOYMENT_NAME", "AI_FOUNDRY_DEPLOYMENT_NAME"];

let cacheDir: string;
let saved: Record<string, string | undefined>;

/** Stubs global fetch with a single JSON response and reports how often it was called. */
function stubFetch(body: unknown): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls: () => calls };
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];

  cacheDir = await mkdtemp(join(tmpdir(), "lena-models-test-"));
  mocks.cacheDir = cacheDir;
  process.env.MICROSOFT_FOUNDRY_DEPLOYMENT_NAME = "gpt-5.6-sol";
  resetContextWindow();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(cacheDir, { recursive: true, force: true });
});

test("resolves the deployment's limits and capabilities from models.dev", async () => {
  stubFetch(CATALOG);

  const limit = await initContextWindow();

  expect(limit.source).toBe("models.dev");
  expect(limit.name).toBe("GPT-5.6 Sol");
  expect(limit.context).toBe(1_050_000);
  expect(limit.reasoning).toBe(true);
  expect(limit.temperature).toBe(false);
});

test("narrows reasoning effort to the levels Lena sends", async () => {
  stubFetch(CATALOG);

  // The catalogue also offers none/xhigh; only low/medium/high survive, in order.
  expect((await initContextWindow()).effort).toEqual(["low", "medium", "high"]);
});

test("reports no capabilities for a model that declares none", async () => {
  stubFetch(CATALOG);

  const limit = await initContextWindow("gpt-5");

  expect(limit.reasoning).toBe(false);
  expect(limit.temperature).toBe(false);
  expect(limit.effort).toEqual([]);
});

test("prefers azure's numbers over openai's for the same model id", async () => {
  stubFetch(CATALOG);

  // openai lists gpt-5.6-sol at 372_000; azure comes first in the search order.
  expect((await initContextWindow()).context).toBe(1_050_000);
});

test("reports limits verbatim — deriving a prompt budget is the caller's job", async () => {
  stubFetch({ azure: { models: { solo: { limit: { context: 100_000, output: 8_000 } } } } });

  const limit = await initContextWindow("solo");

  expect(limit.context).toBe(100_000);
  expect(limit.output).toBe(8_000);
  // Falls back to the id when the catalogue has no display name.
  expect(limit.name).toBe("solo");
});

test("caps generation at the config ceiling, not the model's own maximum", async () => {
  stubFetch(CATALOG);

  // The model allows 128_000; MAX_OUTPUT_TOKENS in config.ts is lower and wins.
  expect((await initContextWindow()).output).toBe(32_768);
});

test("writes only the searched providers to the cache", async () => {
  stubFetch(CATALOG);
  await initContextWindow();

  const cached = JSON.parse(await readFile(join(cacheDir, CACHE_FILE), "utf8"));

  expect(Object.keys(cached).sort()).toEqual(["azure", "azure-cognitive-services", "openai"]);
  expect(cached.azure["gpt-5.6-sol"]).toEqual({
    name: "GPT-5.6 Sol",
    context: 1_050_000,
    output: 128_000,
    reasoning: true,
    temperature: false,
    effort: ["low", "medium", "high"],
  });
});

test("serves a fresh cache without re-downloading", async () => {
  const fetched = stubFetch(CATALOG);

  await initContextWindow();
  resetContextWindow();
  const second = await initContextWindow();

  expect(fetched.calls()).toBe(1);
  expect(second.context).toBe(1_050_000);
});

test("re-downloads once the cache passes its 24h TTL", async () => {
  const fetched = stubFetch(CATALOG);
  await initContextWindow();

  // Backdate the cache file's mtime past the TTL — freshness is judged on metadata.
  const path = join(cacheDir, CACHE_FILE);
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(path, stale, stale);
  const before = (await stat(path)).mtimeMs;

  resetContextWindow();
  await initContextWindow();

  expect(fetched.calls()).toBe(2);
  expect((await stat(path)).mtimeMs).toBeGreaterThan(before);
});

test("falls back to a stale cache when the refresh fails", async () => {
  stubFetch(CATALOG);
  await initContextWindow();

  const path = join(cacheDir, CACHE_FILE);
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(path, stale, stale);

  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  resetContextWindow();
  const limit = await initContextWindow();

  expect(limit.source).toBe("models.dev");
  expect(limit.context).toBe(1_050_000);
});

test("falls back to the conservative default when models.dev is unreachable", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });

  const limit = await initContextWindow();

  expect(limit.source).toBe("default");
  expect(limit.context).toBe(200_000);
});

test("falls back to the default for a deployment name the catalogue doesn't list", async () => {
  stubFetch(CATALOG);

  const limit = await initContextWindow("lena-prod-whatever");

  expect(limit.source).toBe("default");
  expect(limit.context).toBe(200_000);
  expect(limit.output).toBe(32_768);
});

test("getContextWindow returns the default before init runs", () => {
  const limit = getContextWindow();

  expect(limit.source).toBe("default");
  expect(limit.context).toBe(200_000);
});

test("getContextWindow returns the resolved limits after init", async () => {
  stubFetch(CATALOG);
  await initContextWindow();

  expect(getContextWindow().context).toBe(1_050_000);
});
