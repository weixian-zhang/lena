import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { CONTEXT_WINDOW_TOKENS, MAX_OUTPUT_TOKENS } from "../util/config.js";

/**
 * Describe a model to pi-ai. `api` picks the wire protocol pi-ai speaks to it
 * ("openai-responses", "anthropic-messages", …); `id` is the model or
 * deployment name sent as each request's `model` field.
 *
 * `provider` is pi-ai's `KnownProvider` rather than its `ProviderId`, which
 * erases to `string` and checks nothing. Cost is zeroed: we pay per deployment
 * rather than per token, so pi-ai's cost accounting is noise.
 */
export function createModel<TApi extends Api>(spec: {
  provider: KnownProvider;
  api: TApi;
  id: string;
  baseUrl: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Model<TApi> {
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
