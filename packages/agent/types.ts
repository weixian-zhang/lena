import type { LLM, LLMEvent, LLMMessage, LLMThinkingLevel } from "@lena/llm";
import type { Toolbox } from "@lena/tool";

/**
 * Everything one session's agent works from. `llm` and `toolbox` are shared by reference across
 * sessions of the same agent kind; `history` belongs to this session alone.
 */
export type AgentContext = {
  llm: LLM;
  toolbox: Toolbox;
  systemPrompt: string;
  /** Hard cap on model calls in one turn. Default 50. */
  maxSteps?: number;
  thinkingLevel?: LLMThinkingLevel;
  /** The conversation so far; the loop appends each message as it happens. */
  history: LLMMessage[];
};

/** What changes every turn; built by the session runner. */
export type TurnInput = {
  /** Aborts the model stream and the running tool. */
  signal?: AbortSignal;
  /** Drains every pending message; called before the first step and at every step boundary. */
  drainSteerMessages?: () => LLMMessage[];
};

export type TurnEndReason = "stop" | "max_steps" | "error" | "cancelled";

/** What a turn streams to its caller, in order. */
export type LoopEvent =
  | { type: "step_start"; step: number }
  | { type: "llm"; event: LLMEvent }
  | { type: "steer_applied"; messages: LLMMessage[] }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; isError: boolean }
  /** `answer` is the final reply on `"stop"`; `error` says why on `"error"`. */
  | {
      type: "turn_end";
      reason: TurnEndReason;
      answer?: string;
      error?: string;
    };

/** What the user did, not what it means — the runner decides from its state. Plain JSON. */
export type AgentCommand =
  | { kind: "prompt"; sessionKey: string; prompt: string }
  | {
      kind: "answer";
      sessionKey: string;
      questionId: string;
      answers: QuestionAnswer[];
    }
  | { kind: "stop"; sessionKey: string };

/** One answer per question: the chosen labels, and/or free text. Placeholder until `ask_user`. */
export type QuestionAnswer = {
  header: string;
  selected: string[];
  otherText?: string;
};

/** Inbound commands and outbound replies; backed later by a queue table (SQLite / Postgres). */
export interface Mailroom {
  /** Commands in arrival order; the agent factory drains it. */
  receive(): AsyncIterable<AgentCommand>;
  /** Delivers to the chat the session module resolves for `sessionKey`. */
  reply(sessionKey: string, text: string): Promise<void>;
}
