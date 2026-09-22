# `agent-core` — Lena's own agent loop

## Goal

A self-contained module holding Lena's agent loop: a `while` loop split into `turn()` and
`step()`, plus a basic `Tool` type. It owns its control flow, its termination rules and its
event contract.

The `turn()` / `step()` naming is taken from deepseek-harness
(`packages/core/agent-loop/src/agent.ts:269,352`) — `turn()` is the user-facing unit, `step()`
is one model call. The discipline of delegating all provider work to a single injected
stream function is from pi (`packages/agent/src/agent-loop.ts:155`).

This module depends on nothing else in the repo. It is exercised by its own test with a fake
model, and can be wired into the app separately.

## Dependency boundary

| Ours | `@mariozechner/pi-ai` |
|---|---|
| The loop: `turn()`, `step()`, tool dispatch | HTTP, SSE parsing, provider quirks |
| `Tool`, `ToolResult`, `LoopEvent`, `LoopOptions` | `Message`, `Model`, `AssistantMessage` |
| Termination rules, step cap | `streamSimple()`, `AssistantMessageEvent` deltas |
| Turning a thrown tool error into a result | Assembling deltas into a final message |

We write the agent loop. We do not write a wire protocol. `pi-ai` is used as a library and
never vendored or forked; the loop touches it only through the `StreamFunction` type, so
swapping it for a raw SDK later means replacing one injected function.

## Module layout

```
src/backend/src/agent-core/
  types.ts    contracts — no imports from the rest of the repo
  loop.ts     turn(), step(), runToolCall()
```

## Contracts — `types.ts`

```ts
import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  StreamFunction,
  TextContent,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "typebox";

/** What a tool hands back to the model. */
export type ToolResult = {
  content: (TextContent | ImageContent)[];
};

/** A tool the model can call. Throw on failure — the loop turns it into an error result. */
export type Tool<TParams extends TSchema = TSchema> = {
  name: string;
  description: string;
  parameters: TParams;
  execute(args: Static<TParams>): Promise<ToolResult>;
};

export type TurnEndReason = "stop" | "max_steps" | "error";

export type LoopEvent =
  | { type: "step_start"; step: number }
  | { type: "message_update"; event: AssistantMessageEvent }  // pi-ai's delta union, forwarded as-is
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; result: ToolResult; isError: boolean }
  | { type: "turn_end"; reason: TurnEndReason };

export type LoopOptions = {
  model: Model<any>;
  systemPrompt: string;
  tools: Tool[];
  /** Injected so tests drive the loop without a live endpoint. Defaults to pi-ai's `streamSimple`. */
  stream?: StreamFunction;
  /** Resolved per model call, so short-lived bearer tokens stay fresh across long tool runs. */
  getApiKey?: () => Promise<string | undefined>;
  /** Hard cap on model calls in one turn. Default 50. */
  maxSteps?: number;
};
```

The tool type has four fields. Everything a fuller framework adds — labels, per-tool
execution modes, partial-result callbacks, argument shims, early-termination hints, abort
signals — is left out until something needs it.

## Control flow — `loop.ts`

Exported surface on top, helpers below.

### `turn()` — the while loop

```ts
export async function* turn(
  options: LoopOptions,
  messages: Message[],
): AsyncGenerator<LoopEvent, Message[]>
```

Owns the step counter and the turn's outcome. `messages` is the conversation so far; the
loop appends to it and returns it.

```
let step = 0;
while (true) {
  step++;
  if (step > maxSteps) { yield turn_end("max_steps"); return messages; }
  yield step_start(step);
  const reason = yield* runStep(options, messages);   // forwards every event it yields
  if (reason) { yield turn_end(reason); return messages; }
}
```

An `AsyncGenerator` rather than a callback or an event emitter: `for await` gives the caller
backpressure for free, and maps directly onto SSE when a transport is added.

### `step()` — one model call plus its tools

Returns a `TurnEndReason` to end the turn, or `null` to go round again.

1. `stream(model, { systemPrompt, messages, tools }, { apiKey })`
2. forward each event as `message_update`; keep the final `AssistantMessage`
3. push that message onto `messages`
4. branch on `stopReason` and content — see the table below
5. if there are tool calls, run them in order, pushing each `ToolResultMessage` onto
   `messages`, then return `null`

Tools run **sequentially**. Lena's tools act on live Azure subscriptions, where ordering is
observable; it is also less code than a batch scheduler.

### Termination rules

| Condition | Result |
|---|---|
| `stopReason` is `"error"` or `"aborted"` | `turn_end: "error"` — tools are **not** run |
| Assistant message has no `toolCall` blocks | `turn_end: "stop"` |
| Step counter exceeds `maxSteps` | `turn_end: "max_steps"` |
| Assistant message has tool calls | run them, then another step |

The step cap has no equivalent in either reference loop — both run until the model stops.
Lena acts on real subscriptions, so an unbounded loop is a cost and blast-radius risk.

### `runToolCall()` — the one place a throw becomes data

```
unknown tool name              → error ToolResultMessage
args fail schema validation    → error ToolResultMessage
tool.execute() throws          → error ToolResultMessage, isError: true
```

No exception escapes the loop. That is what lets a tool body use a plain `throw` for failure
instead of encoding errors into its return content — the model sees the message as a normal
tool result and can react to it.

`stopReason: "length"` needs no special case here. A truncated response can cut a tool call's
JSON arguments mid-string, but those arguments then fail validation and become an ordinary
error result, so the model is told what went wrong.

## Verification

1. `npm run typecheck` — passes under `strict`, `noUncheckedIndexedAccess`,
   `verbatimModuleSyntax`.
2. `test/agent-core.test.ts` — a fake stream function returning scripted
   `AssistantMessageEventStream`s. It fakes only the process boundary (the model provider);
   the loop and the test tools run for real. Cases:

   | Case | Expected |
   |---|---|
   | text-only response | one step, reason `"stop"` |
   | one tool call | tool ran, result appended, second model call made |
   | two tool calls in one message | executed in model order |
   | tool throws | `isError: true` result reaches the model, loop continues |
   | unknown tool name | error result, not a crash |
   | `stopReason: "error"` | reason `"error"`, tools not run |
   | model always calls a tool | stops at `maxSteps`, reason `"max_steps"` |
   | multi-step run | `getApiKey` awaited on every step, not just the first |

3. `npm run test` — existing suites stay green; this adds a module and changes nothing else.

`vitest.config.ts` globs `test/**/*.test.ts`, so the test lives in `test/`.

## Prerequisite

`typebox` must be added to `package.json` as a direct dependency. It is currently only
resolved transitively.

## Out of scope

Recorded so the gaps are known, each to be added when something needs it:

- **Session persistence** — the seam is `turn()`'s `messages` parameter and return value.
- **Compaction** — the seam is a pre-call transform on `messages` inside `step()`.
- **Cancellation** — an `AbortSignal` threaded through `turn`, `step` and `execute`.
- **Early termination** — a tool result that ends the turn (for ask-the-user style tools).
- **Context hooks** — pre-call and post-tool callbacks on `LoopOptions`.
- **Parallel tool execution**, per-tool execution modes, streaming partial tool results.
- **Steering** — injecting a message mid-turn.
