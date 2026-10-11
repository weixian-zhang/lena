import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMToolCall,
  LLMUsage,
} from "./types.js";

/**
 * Translation between pi-ai's message shapes and Lena's own LLM surface, for one model. Callers
 * outside this package never see a pi-ai type; only this file knows what pi-ai's events and
 * messages look like.
 */
export interface StreamAdapter {
  /** The pi-ai request context for a Lena request. */
  toPiContext(request: LLMRequest): Context;
  /** A pi-ai event as a Lena event, or `undefined` for events Lena doesn't expose. */
  toLLMEvent(event: AssistantMessageEvent): LLMEvent | undefined;
}

export class PiAiStreamAdapter implements StreamAdapter {
  /** `model` fills in the provider metadata that replayed assistant turns need. */
  constructor(private readonly model: Model<Api>) {}

  toPiContext(request: LLMRequest): Context {
    return {
      systemPrompt: request.systemPrompt,
      messages: request.messages.map((message) => this.toPiMessage(message)),
      // Only the definition crosses over, so `execute` never reaches pi-ai.
      tools: request.tools?.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    };
  }

  /**
   * Skips the `*_start`/`*_end` bookkeeping, and the partial tool-call JSON that
   * `toolcall_end` finally delivers parsed.
   */
  toLLMEvent(event: AssistantMessageEvent): LLMEvent | undefined {
    switch (event.type) {
      case "thinking_end":
        return { type: "thinking", text: event.content };
      case "toolcall_end":
        return { type: "tool_call", call: toLLMToolCall(event.toolCall) };
      case "done":
        if (event.reason === "deferred") {
          throw new Error("Deferred responses are not supported.");
        }
        return {
          type: "done",
          reason: event.reason,
          text: assistantText(event.message),
          toolCalls: assistantToolCalls(event.message),
          usage: toLLMUsage(event.message),
        };
      case "error":
        return {
          type: "error",
          reason: event.reason,
          message:
            event.error.errorMessage ??
            "Model request failed without a message.",
        };
      case "start":
      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "toolcall_start":
      case "toolcall_delta":
        return undefined;
    }
  }

  /** Replayed assistant turns need provider metadata pi-ai uses for accounting, rebuilt with zeroed usage. */
  private toPiMessage(message: LLMMessage): Message {
    const timestamp = Date.now();

    switch (message.role) {
      case "user":
        return { role: "user", content: message.content, timestamp };
      case "toolResult":
        return {
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content,
          isError: message.isError,
          timestamp,
        };
      case "assistant":
        return {
          role: "assistant",
          content: [
            ...(message.content
              ? [{ type: "text" as const, text: message.content }]
              : []),
            ...(message.toolCalls ?? []).map((call): ToolCall => ({
              type: "toolCall",
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          ],
          api: this.model.api,
          provider: this.model.provider,
          model: this.model.id,
          usage: emptyUsage(),
          stopReason: message.toolCalls?.length ? "toolUse" : "stop",
          timestamp,
        };
    }
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function assistantToolCalls(message: AssistantMessage): LLMToolCall[] {
  return message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => toLLMToolCall(block));
}

function toLLMToolCall(call: ToolCall): LLMToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

function toLLMUsage(message: AssistantMessage): LLMUsage {
  return {
    input: message.usage.input,
    output: message.usage.output,
    total: message.usage.totalTokens,
  };
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
