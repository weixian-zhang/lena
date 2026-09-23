import { afterEach, beforeEach, expect, test } from "vitest";
import { loadFoundryConfig } from "../config.js";

// Offline unit test: only process.env is touched.

const KEYS = [
  "MICROSOFT_FOUNDRY_ENDPOINT",
  "MICROSOFT_FOUNDRY_DEPLOYMENT_NAME",
  "AI_FOUNDRY_DEPLOYMENT_NAME",
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("reads the canonical Foundry variables", () => {
  process.env.MICROSOFT_FOUNDRY_ENDPOINT = "  https://lena.openai.azure.com  ";
  process.env.MICROSOFT_FOUNDRY_DEPLOYMENT_NAME = "gpt-5";

  expect(loadFoundryConfig()).toEqual({
    endpoint: "https://lena.openai.azure.com",
    deploymentName: "gpt-5",
  });
});

test("falls back to the legacy deployment name", () => {
  process.env.MICROSOFT_FOUNDRY_ENDPOINT = "https://lena.openai.azure.com";
  process.env.AI_FOUNDRY_DEPLOYMENT_NAME = "gpt-5-alias";

  expect(loadFoundryConfig().deploymentName).toBe("gpt-5-alias");
});

test("names every variable it tried when none is set", () => {
  expect(() => loadFoundryConfig()).toThrow(
    "Missing required environment variable: MICROSOFT_FOUNDRY_ENDPOINT",
  );
});

test("treats a blank value as unset", () => {
  process.env.MICROSOFT_FOUNDRY_ENDPOINT = "https://lena.openai.azure.com";
  process.env.MICROSOFT_FOUNDRY_DEPLOYMENT_NAME = "   ";
  process.env.AI_FOUNDRY_DEPLOYMENT_NAME = "gpt-5-fallback";

  expect(loadFoundryConfig().deploymentName).toBe("gpt-5-fallback");
});







