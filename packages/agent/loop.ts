import type { LLMEvent, LLMMessage, LLMRequest, LLMToolCall } from "@lena/llm";
import type { Tool, ToolContent } from "@lena/tool";
import { Value } from "typebox/value";
import type { AgentContext, LoopEvent, TurnInput } from "./types.js";

/** One session's agent: runs turns over its `AgentContext`, appending every message to its history. */
export class AgentLoop {

  constructor(private readonly context: AgentContext) {}

  /**
   * Runs one turn: a step per model call, until a step runs no tools and no steers are pending.
   * Always ends with one `turn_end`; model and tool failures become events, never exceptions.
   */
  async *runTurn(turn: TurnInput): AsyncGenerator<LoopEvent, void> {
    const turnEnd: TurnEndEvent = yield* this.runSteps(turn);
    yield turnEnd;
  }

  /** The steps of one turn; returns the `turn_end` instead of yielding it, so there is exactly one. */
  private async *runSteps(
    turn: TurnInput,
  ): AsyncGenerator<LoopEvent, TurnEndEvent> {
    const signal: AbortSignal | undefined = turn.signal;
    const drainSteerMessages: () => LLMMessage[] =
      turn.drainSteerMessages ?? (() => []);
    const maxSteps = this.context.maxSteps ?? DEFAULT_MAX_STEPS;
    const history: LLMMessage[] = this.context.history;

    let steerMessages: LLMMessage[] = drainSteerMessages();

    for (let step = 1; ; step++) {
      if (signal?.aborted) return { type: "turn_end", reason: "cancelled" };
      if (step > maxSteps) return { type: "turn_end", reason: "max_steps" };

      if (steerMessages.length > 0) {
        history.push(...steerMessages);
        yield { type: "steer_applied", messages: steerMessages };
        steerMessages = [];
      }

      yield { type: "step_start", step };

      const outcome: ModelCallOutcome = yield* this.streamLLM(signal);
      if (outcome.type === "error") {
        const reason = outcome.reason === "aborted" ? "cancelled" : "error";
        return { type: "turn_end", reason, error: outcome.message };
      }

      const text = outcome.text;
      const toolCalls: LLMToolCall[] = outcome.toolCalls;
      history.push(
        toolCalls.length > 0
          ? { role: "assistant", content: text, toolCalls }
          : { role: "assistant", content: text },
      );

      for (const [index, call] of toolCalls.entries()) {
        if (signal?.aborted) {
          this.closeDanglingToolCalls(toolCalls.slice(index));
          return { type: "turn_end", reason: "cancelled" };
        }

        yield {
          type: "tool_start",
          toolCallId: call.id,
          name: call.name,
          args: call.arguments,
        };

        const result: ToolResultMessage = await this.runToolCall(call, signal);
        history.push(result);
        
        yield {
          type: "tool_end",
          toolCallId: call.id,
          name: call.name,
          isError: result.isError,
        };
      }
      if (signal?.aborted) return { type: "turn_end", reason: "cancelled" };

      // Collected after the tools so a steer sent during them, or during a final answer, gets a step.
      steerMessages = drainSteerMessages();
      if (toolCalls.length > 0 || steerMessages.length > 0) continue;

      return { type: "turn_end", reason: "stop", answer: text };
    }
  }

  /** Forwards one model call's events and returns its terminal `done` or `error`. */
  private async *streamLLM(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<LoopEvent, ModelCallOutcome> {

    const request: LLMRequest = {
      systemPrompt: this.context.systemPrompt,
      // A copy: the history keeps growing while the provider may still hold the request.
      messages: [...this.context.history],
      tools: this.context.toolbox.list(),
      signal,
      thinkingLevel: this.context.thinkingLevel,
    };

    const events: AsyncGenerator<LLMEvent, void> =
      this.context.llm.stream(request);

    for await (const event of events) {
      yield { type: "llm", event };
      if (event.type === "done" || event.type === "error") return event;
    }

    return {
      type: "error",
      reason: "error",
      message: "The model stream ended without a done or error event.",
    };
  }

  /** Runs one tool call; an unknown tool, invalid arguments or a throw becomes an error result. */
  private async runToolCall(
    call: LLMToolCall,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultMessage> {
    try {
      const tool: Tool = this.context.toolbox.get(call.name);
      if (!Value.Check(tool.parameters, call.arguments)) {
        const problems = Value.Errors(tool.parameters, call.arguments)
          .map((error) => `${error.instancePath || "/"} ${error.message}`)
          .join("; ");
        return toolResult(
          call,
          `Invalid arguments for "${call.name}": ${problems}`,
          true,
        );
      }

      return toolResult(
        call,
        await tool.execute(call.arguments, signal),
        false,
      );
    } catch (error) {
      if (signal?.aborted) return toolResult(call, CANCELLED_TOOL_RESULT, true);
      return toolResult(
        call,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  /** Gives every call that never ran a cancelled result, so the next turn's history stays valid. */
  private closeDanglingToolCalls(calls: LLMToolCall[]): void {
    for (const call of calls)
      this.context.history.push(toolResult(call, CANCELLED_TOOL_RESULT, true));
  }
}

const DEFAULT_MAX_STEPS = 50;

/** Told to the model for a call a stop interrupted or skipped. */
const CANCELLED_TOOL_RESULT =
  "Cancelled by the user. Do not retry automatically.";

type ModelCallOutcome = Extract<LLMEvent, { type: "done" | "error" }>;

type TurnEndEvent = Extract<LoopEvent, { type: "turn_end" }>;

type ToolResultMessage = Extract<LLMMessage, { role: "toolResult" }>;

function toolResult(
  call: LLMToolCall,
  content: string | ToolContent[],
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError,
  };
}
