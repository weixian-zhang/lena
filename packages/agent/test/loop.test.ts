import type {
  LLM,
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMToolCall,
} from "@lena/llm";
import type { Tool } from "@lena/tool";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import {
  countSteps,
  createContext,
  drainOnce,
  runAgentLoop,
  user,
} from "./helpers.js";

describe("steps and tools", () => {
  test("a text-only response is one step that ends with the answer", async () => {
    const llm = new MockLLM([answer("Hello.")]);
    const context = createContext(llm, []);

    const events = await runAgentLoop(context, {
      drainSteerMessages: drainOnce([user("Hi")]),
    });

    expect(countSteps(events)).toBe(1);
    expect(events.at(-1)).toEqual({
      type: "turn_end",
      reason: "stop",
      answer: "Hello.",
    });
    expect(llm.requests[0]?.messages).toEqual([user("Hi")]);
    expect(llm.requests[0]?.systemPrompt).toBe("You are Lena.");
    expect(context.history).toEqual([
      user("Hi"),
      { role: "assistant", content: "Hello." },
    ]);
  });

  test("a tool call runs, and its result reaches the next model call", async () => {
    const echo = echoTool();
    const llm = new MockLLM([
      callTools(toolCall("c1", "echo", { text: "ping" })),
      answer("Done."),
    ]);
    const context = createContext(llm, [echo], [user("Echo ping")]);

    const events = await runAgentLoop(context);

    expect(countSteps(events)).toBe(2);
    expect(llm.requests[1]?.messages.at(-1)).toEqual(
      result("c1", "echo", "ping"),
    );
    expect(events.at(-1)).toMatchObject({ reason: "stop", answer: "Done." });
  });

  test("two tool calls run in model order within one step", async () => {
    const echo = echoTool();
    const llm = new MockLLM([
      callTools(
        toolCall("c1", "echo", { text: "first" }),
        toolCall("c2", "echo", { text: "second" }),
      ),
      answer("Done."),
    ]);
    const context = createContext(llm, [echo], [user("Echo twice")]);

    const events = await runAgentLoop(context);

    expect(echo.received).toEqual(["first", "second"]);
    expect(countSteps(events)).toBe(2);
    expect(llm.requests[1]?.messages.slice(-2)).toEqual([
      result("c1", "echo", "first"),
      result("c2", "echo", "second"),
    ]);
  });

  test("a throwing tool, an unknown tool and invalid arguments become error results", async () => {
    const llm = new MockLLM([
      callTools(
        toolCall("c1", "fail", {}),
        toolCall("c2", "missing", {}),
        toolCall("c3", "echo", { text: 5 }),
      ),
      answer("Sorry."),
    ]);
    const context = createContext(
      llm,
      [echoTool(), failingTool("disk full")],
      [user("Try")],
    );

    const events = await runAgentLoop(context);

    expect(llm.requests[1]?.messages.slice(-3)).toEqual([
      errorResult("c1", "fail", "disk full"),
      errorResult("c2", "missing", 'Unknown tool: "missing".'),
      errorResult(
        "c3",
        "echo",
        'Invalid arguments for "echo": /text must be string',
      ),
    ]);
    expect(events.at(-1)).toMatchObject({ reason: "stop" });
  });

  test("a model error ends the turn without running tools", async () => {
    const echo = echoTool();
    const llm = new MockLLM([
      [{ type: "error", reason: "error", message: "rate limited" }],
    ]);
    const context = createContext(llm, [echo], [user("Hi")]);

    const events = await runAgentLoop(context);

    expect(events.at(-1)).toEqual({
      type: "turn_end",
      reason: "error",
      error: "rate limited",
    });
    expect(echo.received).toEqual([]);
    expect(context.history).toEqual([user("Hi")]);
  });

  test("a model that always calls a tool stops at maxSteps", async () => {
    const llm = new MockLLM(
      [1, 2, 3].map((n) =>
        callTools(toolCall(`c${n}`, "echo", { text: "again" })),
      ),
    );
    const context = {
      ...createContext(llm, [echoTool()], [user("Loop")]),
      maxSteps: 3,
    };

    const events = await runAgentLoop(context);

    expect(llm.requests).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_steps" });
  });
});

describe("steering", () => {
  test("steers sent during a tool reach the next model call together", async () => {
    const steers: LLMMessage[] = [];
    const steeringTool = toolThatRuns(() =>
      steers.push(user("Only East US"), user("Skip stopped VMs")),
    );
    const llm = new MockLLM([
      callTools(toolCall("c1", "work", {})),
      answer("Filtered."),
    ]);
    const context = createContext(llm, [steeringTool], [user("List VMs")]);

    const events = await runAgentLoop(context, {
      drainSteerMessages: () => steers.splice(0),
    });

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.messages.slice(-3)).toEqual([
      result("c1", "work", "ok"),
      user("Only East US"),
      user("Skip stopped VMs"),
    ]);
    expect(events).toContainEqual({
      type: "steer_applied",
      messages: [user("Only East US"), user("Skip stopped VMs")],
    });
  });

  test("a steer sent during the final answer runs one more step", async () => {
    const steers: LLMMessage[] = [];
    const llm = new MockLLM([
      () => {
        steers.push(user("Also check the bill"));
        return answer("Here are your VMs.");
      },
      answer("And your bill."),
    ]);
    const context = createContext(llm, [], [user("List VMs")]);

    const events = await runAgentLoop(context, {
      drainSteerMessages: () => steers.splice(0),
    });

    expect(countSteps(events)).toBe(2);
    expect(llm.requests[1]?.messages.at(-1)).toEqual(
      user("Also check the bill"),
    );
    expect(events.at(-1)).toMatchObject({
      reason: "stop",
      answer: "And your bill.",
    });
  });
});

describe("stop", () => {
  test("a stop during a tool cancels the turn and closes every dangling call", async () => {
    const controller = new AbortController();
    const echo = echoTool();
    const blockingTool = toolThatRuns((signal) => {
      controller.abort();
      return waitForAbort(signal);
    });
    const llm = new MockLLM([
      callTools(
        toolCall("c1", "work", {}),
        toolCall("c2", "echo", { text: "never" }),
      ),
    ]);
    const context = createContext(llm, [blockingTool, echo], [user("Deploy")]);

    const events = await runAgentLoop(context, { signal: controller.signal });

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(echo.received).toEqual([]);
    expect(context.history.slice(-2)).toEqual([
      errorResult("c1", "work", CANCELLED),
      errorResult("c2", "echo", CANCELLED),
    ]);
  });

  test("a stop during the model stream cancels the turn without an assistant message", async () => {
    const controller = new AbortController();
    const llm = new MockLLM([
      async function* (request) {
        yield { type: "thinking", text: "Planning." };
        controller.abort();
        await waitForAbort(request.signal).catch(() => {});
        yield {
          type: "error",
          reason: "aborted",
          message: "Request was aborted.",
        };
      },
    ]);
    const context = createContext(llm, [], [user("Hi")]);

    const events = await runAgentLoop(context, { signal: controller.signal });

    expect(events.at(-1)).toEqual({
      type: "turn_end",
      reason: "cancelled",
      error: "Request was aborted.",
    });
    expect(context.history).toEqual([user("Hi")]);
  });
});

/** Told to the model for a call a stop interrupted or skipped; mirrors the loop's text. */
const CANCELLED = "Cancelled by the user. Do not retry automatically.";

/**
 * The model provider is the process boundary, so it is faked: each call replays the next scripted
 * reply — a fixed event list, a function returning one, or a generator for replies that wait.
 */
class MockLLM implements LLM {
  readonly requests: LLMRequest[] = [];

  constructor(private readonly replies: ScriptedReply[]) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent, void> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (!reply)
      throw new Error(
        `No scripted reply left for model call ${this.requests.length}.`,
      );

    if (Array.isArray(reply)) yield* reply;
    else {
      const produced = reply(request);
      if (Array.isArray(produced)) yield* produced;
      else yield* produced;
    }
  }
}

type ScriptedReply =
  | LLMEvent[]
  | ((request: LLMRequest) => LLMEvent[] | AsyncGenerator<LLMEvent, void>);

function echoTool(): Tool & { received: string[] } {
  const received: string[] = [];
  return {
    name: "echo",
    description: "Returns its text.",
    parameters: Type.Object({ text: Type.String() }),
    received,
    async execute({ text }: { text: string }) {
      received.push(text);
      return text;
    },
  };
}

function failingTool(message: string): Tool {
  return {
    name: "fail",
    description: "Always throws.",
    parameters: Type.Object({}),
    async execute() {
      throw new Error(message);
    },
  };
}

/** A tool named `work` that runs `body` and answers "ok". */
function toolThatRuns(body: (signal?: AbortSignal) => unknown): Tool {
  return {
    name: "work",
    description: "Does some work.",
    parameters: Type.Object({}),
    async execute(_args, signal) {
      await body(signal);
      return "ok";
    },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMToolCall {
  return { id, name, arguments: args };
}

function answer(text: string): LLMEvent[] {
  return [done(text, "stop", [])];
}

function callTools(...toolCalls: LLMToolCall[]): LLMEvent[] {
  return [done("", "toolUse", toolCalls)];
}

function done(
  text: string,
  reason: "stop" | "toolUse",
  toolCalls: LLMToolCall[],
): LLMEvent {
  return {
    type: "done",
    reason,
    text,
    thinking: "",
    toolCalls,
    usage: { input: 0, output: 0, total: 0 },
  };
}

function result(
  toolCallId: string,
  toolName: string,
  content: string,
): LLMMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError: false };
}

function errorResult(
  toolCallId: string,
  toolName: string,
  content: string,
): LLMMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError: true };
}
