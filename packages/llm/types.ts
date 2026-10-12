import type { Tool, ToolContent } from "@lena/tool/tool";

/**
 * Lena's own LLM surface. Callers depend on these types, never on the OpenAI SDK's —
 * `responses-adapter.ts` is where the two meet.
 */

/** How hard a reasoning model thinks; sent as the Responses API's `reasoning.effort`. */
export const LLM_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type LLMThinkingLevel = (typeof LLM_THINKING_LEVELS)[number];

/** A tool invocation the model asked for. */
export type LLMToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * A turn in the conversation. Assistant turns carry the tool calls they made and
 * `toolResult` turns carry the answers, so a full tool round trip can be replayed
 * back to the model.
 */
export type LLMMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LLMToolCall[] }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: string | ToolContent[];
      isError: boolean;
    };

/** One model call, on the model the `LLM` was built for. */
export type LLMRequest = {
  systemPrompt?: string;
  messages: LLMMessage[];
  tools?: readonly Tool[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Omitted: the deployment's default. A deployment that can't reason rejects it with an `error` event. */
  thinkingLevel?: LLMThinkingLevel;
};

export type LLMUsage = { input: number; output: number; total: number };

/**
 * Why the model stopped. `toolUse` means it is waiting on the tool calls in the
 * `done` event; the caller runs them and sends the results back as `toolResult`
 * messages. `outputLengthExceeded` means the reply was cut off at `maxTokens` or the deployment's limit.
 */
export type LLMStopReason = "stop" | "outputLengthExceeded" | "toolUse";

/**
 * Output of one model call. Exactly one terminal event — `done` or `error` —
 * ends every stream; `done.text` excludes thinking, which `done.thinking` holds in full.
 */
export type LLMEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: LLMToolCall }
  | {
      type: "done";
      reason: LLMStopReason;
      text: string;
      /** All `thinking` deltas joined, parts separated by a blank line; a summary for OpenAI models. */
      thinking: string;
      toolCalls: LLMToolCall[];
      usage: LLMUsage;
    }
  | { type: "error"; reason: "error" | "aborted"; message: string };
