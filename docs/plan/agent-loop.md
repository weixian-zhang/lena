# Agent loop — Lena's own `turn()` / `step()`

## Goal

Lena owns its agent loop: a `while` loop split into `turn()` (one user-facing turn) and
`step()` (one model call plus its tools), with steering and stop. One loop runs per session.

- Model calls go through `LLM.stream()` (`packages/agent/llm`); pi-ai is transport only.
- Tools are `Tool` / `Toolbox` from `@lena/tool`.
- Not pi-agent-core's `Agent`. `packages/agent/agent.ts` wraps it only until this loop replaces it.

## Layout

```
packages/agent/loop/
  types.ts           LoopOptions, LoopEvent, TurnEndReason
  turn.ts            turn(), step(), runToolCall()
  session-runner.ts  SessionRunner — inbox, stop, next-turn start
  agent-factory.ts   AgentFactory — creates and finds runners by session key
```

## Contracts

```ts
type LoopOptions = {
  llm: LLM;
  systemPrompt: string;
  tools: Toolbox;
  /** Hard cap on model calls in one turn. Default 50. */
  maxSteps?: number;
  /** Aborts the model stream and the running tool. */
  signal?: AbortSignal;
  /** Messages the user sent since the last step; called at the top of every step and before stopping. */
  takeSteers?: () => LLMMessage[];
};

type TurnEndReason = "stop" | "max_steps" | "error" | "cancelled";

type LoopEvent =
  | { type: "step_start"; step: number }
  | { type: "llm"; event: LLMEvent }
  | { type: "steer_applied"; messages: LLMMessage[] }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; isError: boolean }
  | { type: "turn_end"; reason: TurnEndReason };
```

`turn(options, history)` is an `AsyncGenerator<LoopEvent, LLMMessage[]>`: `for await` gives the
caller backpressure and maps onto SSE. It never sees the inbox — only `takeSteers`.

## Turn loop

```
while true
  if signal.aborted                      → end "cancelled"
  if ++step > maxSteps                   → end "max_steps"
  steers = takeSteers()
  if steers → append to history; emit steer_applied
  response = llm.stream(history, tools, signal)
  if error                               → end "error"   (tools not run)
  if aborted                             → end "cancelled"
  if response has tool calls
    run each in order via runToolCall()   (sequential: Azure ordering is observable)
    if aborted → close remaining calls   → end "cancelled"
    continue
  if takeSteers() would return messages  → continue   (steer arrived during the final answer)
  end "stop"
```

`runToolCall()` turns an unknown tool, invalid args, or a thrown `execute()` into an error tool
result, so no exception escapes and the model can react.

On `"cancelled"`, every `tool_use` without a `tool_result` gets an error result — "Cancelled by
the user. Do not retry automatically." — so the next turn's history is valid.

## Sessions, steering and stop

One `SessionRunner` per session key (`{chat-channel}/{chat-id}/{ulid}`). `AgentFactory` creates
runners and finds existing ones by key — one class, because every inbound message needs "find
or create" and two places would have to agree on it.

```ts
interface SessionRunner {
  /** Idle: start a turn with `text`. Running: add it to the inbox as a steer. */
  submit(text: string): void;
  /** Abort the running turn and empty the inbox. No-op when idle. */
  stop(): void;
}

/** The session runners in this process, one per session key. */
interface AgentFactory {
  /** The runner for `sessionKey`, created on first use. */
  getOrCreate(sessionKey: string): SessionRunner;
}
```

- The factory only finds or creates. It never enqueues: whether a message starts a turn,
  becomes a steer or aborts depends on the agent's state, so each agent owns its inbox.
- The constructor takes what every runner shares (`LLM`, `Toolbox`, system prompt), so
  `getOrCreate` needs only the key.
- The gateway routes both kinds the same way: `factory.getOrCreate(key).submit(text)` or
  `.stop()`. A stop for an unknown key creates an idle runner, which does nothing.
- It knows only this process's runners; finding a key's owner across instances is routing.

Inbound messages carry an explicit kind set by the channel or UI (`message` or `stop`), never
guessed from the text. The runner handles each one on arrival:

| Arrives | Idle | Turn running |
|---|---|---|
| `message` | start a turn | push onto the inbox |
| `stop` | no-op, reported | empty the inbox, `abort()` |

- **One queue: the inbox.** Stop never enters it — the inbox is read only at step boundaries, so
  a queued stop would wait behind a long tool.
- **No step-level queue.** Without retries or hooks, "tools were called, go again" is the `while`
  condition. Kimi Code's prompt queue and step request queue are not adopted.
- **Where a steer lands:** after the current step's tool results, before the next model call.
  A steer during the final answer runs one more step. Remaining tool calls are not skipped.
- **No lost messages.** When a turn ends, the inbox check and the switch to idle run in one
  synchronous block. Leftover messages start the next turn — except after a stop.
- **Stop latency.** The model stream aborts at once; `bash` kills its process tree. A tool that
  ignores the signal delays the stop until it returns.
- **One owner per session key.** The inbox is in memory, so a session key must be owned by one
  process, and both `message` and `stop` must route to it.

## Verification

A test with a fake `LLM` (the process boundary); the loop and tools run for real.

| Case | Expected |
|---|---|
| text-only response | one step, `"stop"` |
| tool call | tool runs, result appended, second model call |
| two tool calls | run in model order |
| tool throws / unknown tool | error result reaches the model, loop continues |
| model error | `"error"`, tools not run |
| model always calls a tool | `"max_steps"` |
| steer during a tool | applied before the next model call |
| steer during the final answer | one more step |
| steer in the same tick the turn ends | starts a new turn, not lost |
| stop during a tool | `"cancelled"`, dangling calls closed, inbox emptied |
| stop while idle | no-op |

## Out of scope

Each added when something needs it:

- Session persistence and compaction.
- Removing idle runners from `AgentFactory` — a runner holds its history in memory, so removal
  waits for persistence.
- Early termination — a tool result that ends the turn.
- Parallel tool execution; streaming partial tool results.
- A grace timer for tools that ignore the abort signal.
- Cross-process routing of a session key (sticky routing or Azure Service Bus sessions).
