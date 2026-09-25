import type { Toolbox } from "@lena/tool";

/**
 * Lena's own LLM surface. Callers depend on these types, never on pi-ai's —
 * `stream-adapter.ts` is where the two meet.
 */

/**
 * How to authenticate against Foundry. The caller picks one — typically from a
 * UI — because each option carries its own credentials.
 */
export type FoundryAuth =
  /** A Foundry API key. Simplest, but a secret to store and rotate. */
  | { kind: "apiKey"; key: string }
  /** An Entra service principal. The usual choice for local development. */
  | { kind: "servicePrincipal"; tenantId: string; clientId: string; clientSecret: string }
  /** The hosting service's system-assigned managed identity. No secret to store. */
  | { kind: "systemAssignedManagedIdentity" }
  /** A user's token from an `az login --use-device-code` sign-in done elsewhere.
   *  Must already be scoped to Foundry — a token for ARM looks identical here. */
  | { kind: "deviceCodeUserToken"; token: string };

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
      content: string;
      isError: boolean;
    };

/** One model call. */
export type LLMRequest = {
  systemPrompt?: string;
  messages: LLMMessage[];
  tools?: Toolbox;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
};

export type LLMUsage = { input: number; output: number; total: number };

/**
 * Why the model stopped. `toolUse` means it is waiting on the tool calls in the
 * `done` event; the caller runs them and sends the results back as `toolResult`
 * messages.
 */
export type LLMStopReason = "stop" | "length" | "toolUse";

/**
 * Output of one model call. Exactly one terminal event — `done` or `error` —
 * ends every stream; `done.text` excludes thinking, which arrives separately.
 */
export type LLMEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: LLMToolCall }
  | {
      type: "done";
      reason: LLMStopReason;
      text: string;
      toolCalls: LLMToolCall[];
      usage: LLMUsage;
    }
  | { type: "error"; reason: "error" | "aborted"; message: string };
