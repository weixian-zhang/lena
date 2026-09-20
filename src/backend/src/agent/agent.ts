import { join } from "node:path";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple, type Model } from "@mariozechner/pi-ai";
import { CONTEXT_WINDOW_TOKENS, MAX_OUTPUT_TOKENS } from "../util/config.js";
import { injectTopography, invalidateTopographyAfterMutation } from "./ground-topography.js";

// Load src/backend/.env into process.env for local development
try {
  process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
} catch {
  // No .env file present; rely on the ambient environment.
}

/**
 * Microsoft Foundry connection settings.
 *
 * Authentication is via managed identity (see {@link createManagedIdentityTokenProvider})
 * — no API key is stored, resolved, or rotated. Only the Foundry endpoint and deployment
 * name are read from the environment, so a deployment can be repointed without a code
 * change. See docs/environment_packages.md for the canonical vars.
 */
interface FoundryConfig {
  /** Foundry endpoint URL serving the OpenAI-compatible API. */
  endpoint: string;
  /** Model deployment name sent as the `model` field in each request. */
  deploymentName: string;
}

/**
 * Read a required environment variable, trying `fallbacks` in order if `name` is
 * unset or blank. Throws if none resolve to a non-empty value.
 */
function getEnv(name: string, fallbacks: string[] = []): string {
  const names = [name, ...fallbacks];
  for (const candidate of names) {
    const value = process.env[candidate];
    if (value && value.trim().length > 0) return value.trim();
  }
  throw new Error(`Missing required environment variable: ${names.join(" / ")}`);
}

/**
 * Resolve the Foundry endpoint + deployment from the environment.
 *
 * `MICROSOFT_FOUNDRY_ENDPOINT` / `MICROSOFT_FOUNDRY_DEPLOYMENT_NAME` are the
 * canonical vars (see .env); the `AI_FOUNDRY_*` and `LENA_MODEL_*` aliases let a
 * deployment override without touching the Foundry-specific names.
 */
function loadConfig(): FoundryConfig {
  const endpoint = getEnv("MICROSOFT_FOUNDRY_ENDPOINT", [
    "AI_FOUNDRY_DEPLOYMENT_ENDPOINT",
    "LENA_MODEL_BASE_URL",
  ]);
  const deploymentName = getEnv("MICROSOFT_FOUNDRY_DEPLOYMENT_NAME", [
    "AI_FOUNDRY_DEPLOYMENT_NAME",
    "LENA_MODEL_DEPLOYMENT",
    "LENA_MODEL_ID",
  ]);
  return { endpoint, deploymentName };
}

/**
 * Microsoft Entra ID scope used to acquire bearer tokens for Microsoft Foundry
 * inference when authenticating with a managed identity.
 */
const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

/**
 * Provider id reported to pi for our self-hosted endpoint. This is an arbitrary
 * label — it only needs to be stable so caching/diagnostics group correctly.
 */
const PROVIDER_ID = "foundry-self-hosted";

/**
 * Builds the OpenAI-compatible base URL for a Foundry endpoint, ensuring the
 * `/openai/v1` suffix is present exactly once. pi's `openai-completions`
 * provider appends `/chat/completions` to this base URL.
 */
function toBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/openai/v1") ? trimmed : `${trimmed}/openai/v1`;
}

/**
 * Describes a custom model served from a self-hosted (or Foundry) endpoint that
 * speaks the OpenAI Chat Completions wire protocol.
 *
 * The `api: "openai-completions"` tells pi which provider implementation to use,
 * while `baseUrl` points the request at our own endpoint instead of api.openai.com.
 * All cost/window values are placeholders that can be tuned for the deployed model.
 *
 * @param endpoint - The self-hosted / Foundry resource endpoint URL.
 * @param deploymentName - The model deployment name sent as the request's `model` field.
 */
export function createSelfHostedModel(
  endpoint: string,
  deploymentName: string,
): Model<"openai-completions"> {
  return {
    id: deploymentName,
    name: deploymentName,
    api: "openai-completions",
    provider: deploymentName,
    baseUrl: toBaseURL(endpoint),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

/**
 * Returns a `getApiKey` callback that resolves a fresh Microsoft Entra ID bearer
 * token via managed identity on every turn.
 *
 * `DefaultAzureCredential` resolves the managed identity when running on Azure
 * (and falls back to developer credentials locally), so no secret needs to be
 * stored or rotated. `getBearerTokenProvider` returns a callable that caches the
 * token and refreshes it when it nears expiry. pi's agent loop forwards the
 * resolved string to `streamSimple` as its `apiKey`, which becomes the request's
 * `Authorization: Bearer <token>` header.
 *
 * @see https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id?pivots=ai-foundry-portal#use-microsoft-entra-id-in-your-code
 */
function createManagedIdentityTokenProvider(): (provider: string) => Promise<string> {
  const tokenProvider = getBearerTokenProvider(new DefaultAzureCredential(), FOUNDRY_SCOPE);
  return async (_provider: string) => tokenProvider();
}

export interface CreateAgentOptions {
  /** System prompt sent with each model request. */
  systemPrompt: string;
  /** Tools made available to the agent. */
  tools?: AgentTool<any>[];
  /** Foundry endpoint URL. Defaults to the value resolved by {@link loadConfig}. */
  endpoint?: string;
  /** Model deployment name. Defaults to the value resolved by {@link loadConfig}. */
  deploymentName?: string;
}

/**
 * Builds a pi-agent-core {@link Agent} backed by our self-hosted model and
 * authenticated with a managed-identity token provider.
 *
 * The Foundry endpoint + deployment default to the environment via
 * {@link loadConfig}, but either can be injected through `options` (e.g. for
 * tests or alternate config sources); the environment is only read for values
 * not supplied. `streamFn: streamSimple` is the default driver from pi-ai; we
 * pass it explicitly to make the wiring obvious. `getApiKey` supplies the bearer
 * token per turn — pi-agent-core calls it with the model's provider id and
 * forwards the result to `streamSimple({ apiKey })`.
 *
 * Mutations run one-at-a-time (`toolExecution: "sequential"`) so Lena's
 * supervised, reflective loop stays in control — see CLAUDE.md.
 */
export function createPiAgent(options: CreateAgentOptions): Agent {
  // Only touch the environment for values the caller didn't inject.
  const fallbackEnv =
    options.endpoint !== undefined && options.deploymentName !== undefined
      ? { endpoint: options.endpoint, deploymentName: options.deploymentName }
      : loadConfig();
  const endpoint = options.endpoint ?? fallbackEnv.endpoint;
  const deploymentName = options.deploymentName ?? fallbackEnv.deploymentName;
  const model = createSelfHostedModel(endpoint, deploymentName);

  return new Agent({
    streamFn: streamSimple,
    getApiKey: createManagedIdentityTokenProvider(),
    initialState: {
      model,
      systemPrompt: options.systemPrompt,
      tools: options.tools ?? [],
    },
    toolExecution: "sequential",
    // Ambient grounding: inject a fresh Azure topography snapshot before each model
    // call, and drop the cached snapshot after Lena changes state. See ground-topography.ts.
    transformContext: injectTopography,
    afterToolCall: invalidateTopographyAfterMutation,
  });
}
