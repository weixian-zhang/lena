import type { ToolContent } from "@lena/tool/tool";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type {
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMStopReason,
  LLMToolCall,
  LLMUsage,
} from "./types.js";

/**
 * Translation between the Responses API and Lena's own LLM surface, for one model call. Callers
 * outside this package never see an OpenAI SDK type; only this file knows their shapes.
 */
export interface ResponsesAdapter {
  /** The `responses.create` params for a Lena request on one deployment, always streaming. */
  createResponseParam(
    llmRequest: LLMRequest,
    model: string,
  ): ResponseCreateParamsStreaming;
  /** One stream event as a Lena event, or `undefined` for events Lena doesn't expose. */
  toLLMEvent(event: ResponseStreamEvent): LLMEvent | undefined;
}

/** Holds the text, thinking and tool calls seen so far, so build a new one per call. */
export class FoundryResponsesAdapter implements ResponsesAdapter {
  private text = "";
  private thinking = "";
  private thinkingPart: string | undefined;
  private readonly toolCalls: LLMToolCall[] = [];

  createResponseParam(
    llmRequest: LLMRequest,
    model: string,
  ): ResponseCreateParamsStreaming {
    return {
      model,
      instructions: llmRequest.systemPrompt,
      input: llmRequest.messages.flatMap((message) => toInputItems(message)),
      // Only the definition crosses over, so `execute` never leaves the process.
      tools: llmRequest.tools?.map(({ name, description, parameters }) => ({
        type: "function" as const,
        name,
        description,
        // A typebox schema is plain JSON Schema at runtime; the SDK only lacks the index signature.
        parameters: parameters as Record<string, unknown>,
        strict: false,
      })),
      reasoning: llmRequest.thinkingLevel
        ? { effort: llmRequest.thinkingLevel, summary: "auto" }
        : undefined,
      max_output_tokens: llmRequest.maxTokens,
      temperature: llmRequest.temperature,
      // Every request carries the whole conversation, so nothing is kept server-side.
      store: false,
      stream: true,
    };
  }

  toLLMEvent(event: ResponseStreamEvent): LLMEvent | undefined {
    switch (event.type) {
      case "response.reasoning_summary_text.delta":
        this.appendThinking(
          `${event.item_id}:${event.summary_index}`,
          event.delta,
        );
        return { type: "thinking", text: event.delta };
      case "response.reasoning_text.delta":
        this.appendThinking(
          `${event.item_id}:${event.content_index}`,
          event.delta,
        );
        return { type: "thinking", text: event.delta };
      case "response.output_text.delta":
        this.text += event.delta;
        return undefined;
      case "response.output_item.done": {
        if (event.item.type !== "function_call") return undefined;
        const call: LLMToolCall = {
          id: event.item.call_id,
          name: event.item.name,
          arguments: parseToolArguments(event.item.name, event.item.arguments),
        };
        this.toolCalls.push(call);
        return { type: "tool_call", call };
      }
      case "response.completed":
        return this.done(
          this.toolCalls.length ? "toolUse" : "stop",
          event.response,
        );
      case "response.incomplete":
        // Only running out of output tokens is a normal stop; a content filter is a failure.
        if (event.response.incomplete_details?.reason !== "max_output_tokens") {
          return {
            type: "error",
            reason: "error",
            message: `Response incomplete: ${event.response.incomplete_details?.reason ?? "no reason given"}.`,
          };
        }
        return this.done("outputLengthExceeded", event.response);
      case "response.failed":
        return {
          type: "error",
          reason: "error",
          message:
            event.response.error?.message ??
            "Response failed without a message.",
        };
      case "error":
        return { type: "error", reason: "error", message: event.message };
      default:
        return undefined;
    }
  }

  private done(reason: LLMStopReason, response: Response): LLMEvent {
    return {
      type: "done",
      reason,
      text: this.text,
      thinking: this.thinking,
      toolCalls: this.toolCalls,
      usage: toLLMUsage(response),
    };
  }

  /** A response can hold several reasoning parts; a blank line keeps them from running together. */
  private appendThinking(part: string, delta: string): void {
    if (this.thinking && part !== this.thinkingPart) this.thinking += "\n\n";
    this.thinkingPart = part;
    this.thinking += delta;
  }
}

/** One Lena message as Responses input items; an assistant turn becomes its text plus one item per tool call. */
function toInputItems(message: LLMMessage): ResponseInputItem[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: message.content }];
    case "assistant":
      return [
        ...(message.content
          ? [{ role: "assistant" as const, content: message.content }]
          : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "function_call" as const,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })),
      ];
    case "toolResult":
      return [
        {
          type: "function_call_output",
          call_id: message.toolCallId,
          output:
            typeof message.content === "string"
              ? message.content
              : toFunctionCallOutput(message.content),
        },
      ];
  }
}

function toFunctionCallOutput(
  content: ToolContent[],
): ResponseFunctionCallOutputItemList {
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : {
          type: "input_image",
          image_url: `data:${part.mimeType};base64,${part.data}`,
          detail: "auto",
        },
  );
}

/** Throws naming the tool, since a call with unreadable arguments can't be run. */
function parseToolArguments(
  name: string,
  json: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json || "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(
      `Tool "${name}" was called with non-object arguments: ${json}`,
    );
  return parsed as Record<string, unknown>;
}

function toLLMUsage(response: Response): LLMUsage {
  if (!response.usage)
    throw new Error(`Response ${response.id} finished without usage.`);
  return {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    total: response.usage.total_tokens,
  };
}
