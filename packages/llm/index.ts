import {
  type Api,
  type AuthResult,
  createModels,
  createProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  type CredentialProvider,
  createCredentialProviderFromAuthConfig,
} from "./credential.js";
import {
  assertValidProviderConfig,
  type ModelConfig,
  type ProviderConfig,
} from "./provider-config.js";
import { PiAiStreamAdapter } from "./stream-adapter.js";
import type { LLMApi, LLMEvent, LLMRequest } from "./types.js";

export {
  type ModelConfigStore,
  SqlModelConfigStore,
} from "./model-config-store.js";
export type {
  AuthConfig,
  ModelConfig,
  ProviderConfig,
} from "./provider-config.js";
export { LLM_APIS, LLM_THINKING_LEVELS } from "./types.js";
export type {
  LLMApi,
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMStopReason,
  LLMThinkingLevel,
  LLMToolCall,
  LLMUsage,
} from "./types.js";

/** Streams model calls on the one model it was built for. */
export interface LLM {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent, void>;
}

/**
 * Streams on one Foundry model the caller chose, through pi-ai: the model's `api` picks the SDK,
 * and every request carries a fresh Entra bearer token. Keep one per session and model, not per
 * request, so the credential's token cache is reused.
 */
export class PiAiLLM implements LLM {
  private readonly model: Model<Api>;
  private readonly models = createModels();
  private readonly credentials: CredentialProvider;

  /** Validates the config, then registers a pi-ai provider holding only the chosen model. */
  constructor(
    providerId: string,
    provider: ProviderConfig,
    modelConfig: ModelConfig,
  ) {
    assertValidProviderConfig(providerId, {
      ...provider,
      models: [modelConfig],
    });

    this.credentials = createCredentialProviderFromAuthConfig(provider.auth);

    // Cost is zeroed: Foundry bills per deployment, so pi-ai's per-token accounting is noise.
    this.model = {
      id: modelConfig.id,
      name: modelConfig.name ?? modelConfig.id,
      api: modelConfig.api,
      provider: providerId,
      baseUrl: foundryBaseUrl(provider.resource, modelConfig.api),
      reasoning: modelConfig.reasoning ?? false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: modelConfig.contextWindow,
      maxTokens: modelConfig.maxTokens,
    };

    this.models.setProvider(
      createProvider<Api>({
        id: providerId,
        name: providerId,
        // pi-ai's only non-OAuth auth hook; it carries a bearer header here, never an API key.
        auth: {
          apiKey: {
            name: providerId,
            resolve: () => this.getEntraBearerHeader(),
          },
        },
        models: [this.model],
        api: {
          "openai-responses": openAIResponsesApi(),
          "openai-completions": openAICompletionsApi(),
          "anthropic-messages": anthropicMessagesApi(),
        },
      }),
    );
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent, void> {
    if (request.thinkingLevel && !this.model.reasoning) {
      throw new Error(
        `Model "${this.model.id}" on provider "${this.model.provider}" is not configured for reasoning, but the request asks for thinking level "${request.thinkingLevel}".`,
      );
    }

    const adapter = new PiAiStreamAdapter(this.model);
    const events = this.models.streamSimple(
      this.model,
      adapter.toPiContext(request),
      {
        signal: request.signal,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        reasoning: request.thinkingLevel,
      },
    );

    for await (const event of events) {
      const translated = adapter.toLLMEvent(event);
      if (translated) yield translated;
    }
  }

  /** Runs on every request, so each one carries a fresh token. */
  private async getEntraBearerHeader(): Promise<AuthResult> {
    return {
      auth: {
        headers: {
          Authorization: `Bearer ${await this.credentials.getToken()}`,
        },
      },
    };
  }
}

/** One Foundry host serves every protocol; only the path differs. */
function foundryBaseUrl(resource: string, api: LLMApi): string {
  const host = `https://${resource}.services.ai.azure.com`;
  switch (api) {
    case "openai-responses":
    case "openai-completions":
      return `${host}/openai/v1`;
    case "anthropic-messages":
      return `${host}/anthropic`;
    default: {
      const unknown: never = api;
      throw new Error(`No Foundry route for api "${String(unknown)}".`);
    }
  }
}
