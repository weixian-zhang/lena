import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { LLMEvent, LLMMessage, LLMRequest, LLMToolCall, LLMUsage } from "./types.js";

/**
 * Translation between pi-ai's message shapes and Lena's own LLM surface. Callers
 * outside `llm/` never see a pi-ai type; within it, `model.ts` describes the
 * model and `index.ts` calls the stream function, but only this file knows what
 * pi-ai's events and messages look like.
 */

/**
 * Build the pi-ai request context from a Lena request.
 *
 * Replayed assistant turns need provider metadata pi-ai uses for accounting;
 * the caller shouldn't have to carry it, so it is reconstructed from `model`
 * with zeroed usage.
 */
export function toPiContext(request: LLMRequest, model: Model<Api>): Context {
  return {
    systemPrompt: request.systemPrompt,
    messages: request.messages.map((message) => toPiMessage(message, model)),
    tools: request.tools?.map((tool): Tool => ({ ...tool })),
  };
}

/**
 * Map one pi-ai event onto a Lena event, or `undefined` for the events that
 * carry nothing we expose: the `*_start`/`*_end` bookkeeping, and the partial
 * tool-call JSON that `toolcall_end` finally delivers parsed.
 */
export function toLLMEvent(event: AssistantMessageEvent): LLMEvent | undefined {
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
        message: event.error.errorMessage ?? "Model request failed without a message.",
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

function toPiMessage(message: LLMMessage, model: Model<Api>): Message {
  const timestamp = Date.now();

  switch (message.role) {
    case "user":
      return { role: "user", content: message.content, timestamp };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [{ type: "text", text: message.content }],
        isError: message.isError,
        timestamp,
      };
    case "assistant":
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map(
            (call): ToolCall => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }),
          ),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp,
      };
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
