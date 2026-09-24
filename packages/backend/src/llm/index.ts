import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { toLLMEvent, toPiContext } from "./stream-adapter.js";
import type { LLMEvent, LLMRequest } from "./types.js";

export { createFoundryTokenProvider } from "./credential.js";
export { createModel } from "./model.js";
export type {
  FoundryAuth,
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMStopReason,
  LLMTool,
  LLMToolCall,
  LLMUsage,
} from "./types.js";

/** A model that streams one response per request. */
export type LLM = {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent, void>;
};

export type CreateLLMOptions = {
  model: Model<"openai-responses">;
  /** Resolves the secret sent as the bearer credential, once per model call. */
  getToken: () => Promise<string>;
};

/**
 * Build a model client that streams from `model`.
 *
 * Requests go through pi-ai's `streamSimple` for the OpenAI Responses protocol,
 * the only wire format wired in. The secret resolves per call so an Entra token
 * stays fresh across long turns; pi-ai sends it as `apiKey`, which reaches
 * Foundry as `Authorization: Bearer`.
 */
export function createLLM({ model, getToken }: CreateLLMOptions): LLM {
  return {
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent, void> {
      const events = streamSimple(model, toPiContext(request, model), {
        apiKey: await getToken(),
        signal: request.signal,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      });

      for await (const event of events) {
        const translated = toLLMEvent(event);
        if (translated) yield translated;
      }
    },
  };
}
