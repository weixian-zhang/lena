import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { CONTEXT_WINDOW_TOKENS, MAX_OUTPUT_TOKENS } from "../util/config.js";
import type { FoundryConfig } from "./config.js";

/**
 * What varies between models. `provider` labels it ("openai", "anthropic",
 * "google") and `api` picks the wire protocol pi-ai speaks to it
 * ("openai-responses", "anthropic-messages", …). Everything else has a workable
 * default.
 *
 * `provider` is pi-ai's `KnownProvider` rather than its `ProviderId`: the latter
 * is `KnownProvider | string`, which erases to `string` and checks nothing.
 * Widen it if Lena ever points at a provider pi-ai doesn't name.
 */
export type ModelSpec<TApi extends Api> = {
  provider: KnownProvider;
  api: TApi;
  /** Model or deployment name, sent as each request's `model` field. */
  id: string;
  /** Root the requests are sent to. */
  baseUrl: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

/**
 * Describe a model to pi-ai.
 *
 * Cost is zeroed: we pay per deployment rather than per token, so pi-ai's cost
 * accounting is noise. Give it real rates once a model is billed that way.
 */
export function createModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
  return {
    id: spec.id,
    name: spec.id,
    api: spec.api,
    provider: spec.provider,
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow ?? CONTEXT_WINDOW_TOKENS,
    maxTokens: spec.maxTokens ?? MAX_OUTPUT_TOKENS,
  };
}

/** The only deployment today: Foundry speaking the OpenAI Responses protocol. */
export function createFoundryModel(config: FoundryConfig): Model<"openai-responses"> {
  return createModel({
    provider: "openai",
    api: "openai-responses",
    id: config.deploymentName,
    baseUrl: toFoundryBaseUrl(config.endpoint),
  });
}

/** Ensure the OpenAI-compatible `/openai/v1` suffix is present exactly once. */
function toFoundryBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/openai/v1") ? trimmed : `${trimmed}/openai/v1`;
}
