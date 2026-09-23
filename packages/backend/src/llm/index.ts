import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { toLLMEvent, toPiContext } from "./stream-adapter.js";
import { loadFoundryConfig, type FoundryConfig } from "./config.js";
import { createFoundryTokenProvider } from "./credential.js";
import { createFoundryModel } from "./model.js";
import type { FoundryAuth, LLMEvent, LLMRequest } from "./types.js";

export { createFoundryModel, createModel, type ModelSpec } from "./model.js";
export type { FoundryConfig } from "./config.js";
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
  /** Defaults to the Foundry deployment named by `config`. */
  model?: Model<"openai-responses">;
  /** Ignored when `model` is given. */
  config?: FoundryConfig;
  /** Required unless `getToken` supplies the secret directly. */
  auth?: FoundryAuth;
  /** Bypasses `auth`. Tests use it to run without Entra. */
  getToken?: () => Promise<string>;
};

/**
 * Build a model client, defaulting to the Foundry deployment in the environment.
 *
 * Requests go through pi-ai's `streamSimple` for the OpenAI Responses protocol,
 * the only wire format wired in. The secret resolves per call so an Entra token
 * stays fresh across long turns; pi-ai sends it as `apiKey`, which reaches
 * Foundry as `Authorization: Bearer`.
 */
export function createLLM(options: CreateLLMOptions = {}): LLM {
  const model = options.model ?? createFoundryModel(options.config ?? loadFoundryConfig());
  const getToken = options.getToken ?? createFoundryTokenProvider(requireAuth(options.auth));

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

/** Credentials are the caller's to choose, so there is no sane fallback. */
function requireAuth(auth: FoundryAuth | undefined): FoundryAuth {
  if (!auth) {
    throw new Error("No credentials: pass `auth`, or `getToken` to supply the secret directly.");
  }
  return auth;
}
