import type { TokenCredential } from "@azure/identity";
import OpenAI from "openai";
import { createFoundryTokenProvider } from "./credential.js";
import { FoundryResponsesAdapter } from "./responses-adapter.js";
import type { LLMEvent, LLMRequest } from "./types.js";

/** Streams model calls on the one model it was built for. */
export interface LLM {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent, void>;
}

/** Where and as whom to call Foundry: the Foundry resource name (e.g. "lena-prod") and one model deployment on it. */
export type FoundryLLMConfig = {
  foundryName: string;
  credential: TokenCredential;
  model: string;
};

/**
 * Streams on one Foundry deployment through the Responses API on the resource's `/openai/v1`
 * endpoint. Keep one per session and model, not per request, so the token cache is reused.
 */
export class FoundryLLM implements LLM {
  private readonly client: OpenAI;

  /** Throws on an empty foundryName or model; everything else is the config module's to validate. */
  constructor(private readonly config: FoundryLLMConfig) {
    if (!config.foundryName) throw new Error("Foundry name must not be empty.");
    if (!config.model) throw new Error("Foundry model must not be empty.");

    const baseURL = `https://${config.foundryName}.services.ai.azure.com/openai/v1`;

    this.client = new OpenAI({
      baseURL,
      apiKey: createFoundryTokenProvider(config.credential),
    });
  }

  /** Ends with exactly one `done` or `error`; failures, auth included, never throw out of here. */
  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent, void> {
    const adapter = new FoundryResponsesAdapter();
    try {
      const events = await this.client.responses.create(
        adapter.createResponseParam(request, this.config.model),
        { signal: request.signal },
      );
      for await (const event of events) {
        const llmEvents = adapter.toLLMEvent(event);
        if (!llmEvents) continue;
        yield llmEvents;
        if (llmEvents.type === "done" || llmEvents.type === "error") return;
      }
      yield {
        type: "error",
        reason: "error",
        message: "The response stream ended without completing.",
      };
    } catch (error) {
      yield {
        type: "error",
        reason: request.signal?.aborted ? "aborted" : "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
