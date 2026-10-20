# Agent loop — design

## Goal

Lena owns its agent loop. `AgentFactory` drains commands from the mailroom and hands each to the
`SessionRunner` for its session key. The runner runs turns through its session's `AgentLoop`, whose
`runTurn()` is a `while` over steps with steering and stop. Replies go back through the mailroom.

- Model calls: `LLM.stream()` from `@lena/llm`. Tools: `Toolbox` from `@lena/tool`, run in order —
  Azure ordering is observable. Replaces pi-agent-core's `Agent`.
- Reference: Kimi Code's turn/step loop. Its naming, its rule for continuing and its steer batching
  are taken; its step-request queue is not.
- The mailroom and the session module are black boxes: the session key is an opaque string and
  history is in memory.

## Sessions

- A **session** is one conversation in a chat. "New chat" or `/clear` starts a new session: a new
  session ID, so a new session key and a new `SessionRunner`. Lena has no separate thread concept.
- The agent only ever sees the session key. The session module resolves it both ways: an inbound
  message's chat → the current session key, and a session key → the chat and channel to reply to.
  The address is stored and looked up, never parsed out of the key.

## Turns and steps

- **Turn** — one user request, until nothing is left to do.
- **Step** — one model call plus every tool call it returned, run in order. Their results are read
  by the next step. `maxSteps` counts model calls.
- A turn **continues while the last step ran tools or steers are pending**.

## Flow

```
Mailroom (black box, DB queue table)
  │  receive() yields AgentCommand  { kind, sessionKey, prompt? }   plain JSON
  ▼
AgentFactory                        one per process
  │  builds once: shared parts { llm, toolbox, systemPrompt, maxSteps, thinkingLevel }
  │  drainRequests(): for each AgentCommand
  │      getOrCreate(command.sessionKey)  → finds the runner, or creates one:
  │          context = { ...shared, history: [] }
  │          new SessionRunner(sessionKey, new AgentLoop(context), mailroom)
  │      runner.send(command)
  ▼
SessionRunner                       one per session key
  │  holds: sessionKey, loop, mailroom, inbox, controller (abort)
  │  send(command):
  │      stop   → empty the inbox, controller.abort()
  │      prompt → inbox.push(prompt); if idle, start drainInbox()
  │  drainInbox(): while the inbox is not empty, run one turn:
  │      loop.runTurn({ signal, drainSteerMessages: () => inbox.splice(0) })
  ▼
AgentLoop                           one per session; references the shared llm and toolbox
  │  holds: AgentContext (shared parts + this session's history)
  │  runTurn(turn): while over steps
  │      drainSteerMessages() → append → llm.stream() → run tool calls in order → repeat
  │      until no tools ran and no steers are pending
  │  appends every message to context.history as it happens; yields LoopEvents
  ▼
SessionRunner (again)
     on turn_end: mailroom.reply(sessionKey, answer or a one-line notice)
     inbox not empty? → next turn; otherwise idle
```

- **`AgentCommand`** is data from outside, stored in the queue table. **`AgentContext`** holds live
  objects (an HTTP client, an Azure login, later MCP connections), so it is never queued.
- The fields have three lifetimes: the shared parts are fixed for an agent kind and built once (they
  are expensive); `history` belongs to one session; `signal` and `drainSteerMessages` to one turn.
  So `AgentContext` is per session and only references the shared `llm` and `toolbox`, and
  `TurnInput` stays a separate argument — a reused context never carries an aborted signal.
- `context.history` is the one place a session's conversation lives; the loop appends to it as each
  message happens. Later it becomes the session module's history for the key, so each tool result
  is persisted the moment it exists.
- A research subagent is a different set of shared parts (tools, system prompt) in its own context.

## Contracts

`packages/agent/types.ts`:

```ts
/** Everything one session's agent works from; `llm` and `toolbox` are shared by reference. */
type AgentContext = {
  llm: LLM;
  toolbox: Toolbox;
  systemPrompt: string;
  /** Hard cap on model calls in one turn. Default 50. */
  maxSteps?: number;
  thinkingLevel?: LLMThinkingLevel;
  /** The conversation so far; the loop appends each message as it happens. */
  history: LLMMessage[];
};

/** What changes every turn; built by the runner. */
type TurnInput = {
  /** Aborts the model stream and the running tool. */
  signal?: AbortSignal;
  /** Drains every pending message; called before the first step and at every step boundary. */
  drainSteerMessages?: () => LLMMessage[];
};

type TurnEndReason = "stop" | "max_steps" | "error" | "cancelled";

type LoopEvent =
  | { type: "step_start"; step: number }
  | { type: "llm"; event: LLMEvent }
  | { type: "steer_applied"; messages: LLMMessage[] }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; isError: boolean }
  /** `answer` is the final reply on `"stop"`; `error` says why on `"error"`. */
  | { type: "turn_end"; reason: TurnEndReason; answer?: string; error?: string };

/** What the user did, not what it means — the runner decides from its state. Plain JSON. */
type AgentCommand =
  | { kind: "prompt"; sessionKey: string; prompt: string }
  | { kind: "answer"; sessionKey: string; questionId: string; answers: QuestionAnswer[] }
  | { kind: "stop"; sessionKey: string };

/** Inbound commands and outbound replies; backed later by a queue table (SQLite / Postgres). */
interface Mailroom {
  receive(): AsyncIterable<AgentCommand>;
  /** Delivers to the chat the session module resolves for `sessionKey`. */
  reply(sessionKey: string, text: string): Promise<void>;
}
```

- `AgentLoop.runTurn(turn: TurnInput): AsyncGenerator<LoopEvent, void>` — `for await` gives the
  caller backpressure and maps onto SSE later. It appends to `context.history` and never sees the
  inbox, the session key or the mailroom.
- `Mailroom` lives here so the future mailroom package implements it without an import cycle.

## Turn loop

```
pending = drainSteerMessages()                  ① sent before the turn started
while true                                      one iteration = one step
  if signal.aborted                             → end "cancelled"
  if ++step > maxSteps                          → end "max_steps"
  append pending to history; steer_applied      ② steers enter the history here
  response = llm.stream(history, tools, signal)
  if error                                      → end "error"   (tools not run)
  if aborted                                    → end "cancelled"
  append the assistant message
  run each tool call in order via runToolCall(); append each result
  if aborted → closeDanglingToolCalls()         → end "cancelled"
  pending = drainSteerMessages()                ③ collect at the step boundary
  if tools ran or pending not empty → continue
  end "stop" with answer = the last assistant text

history is context.history: every append lands there at once.
```

- **Steers enter only between steps**: an assistant message's tool calls must be followed by all
  their results before a user message. Remaining tool calls still run.
- **Batching**: ③ drains everything, so steers sent during one step reach the model in one call.
  A steer during the final answer is caught by ③ and runs one more step.
- **Lazy materialization**: a steer stays in the inbox until ③ takes it, so stop can empty the
  inbox without touching the history.
- `runToolCall()` turns an unknown tool, invalid args (typebox) or a thrown `execute()` into an error
  tool result. On `"cancelled"`, every call without a result gets "Cancelled by the user. Do not
  retry automatically.", so the next turn's history is valid.

## Session runner

| Arrives | Idle | Turn running |
|---|---|---|
| `prompt` | push; start `drainInbox()` | push; becomes a steer at the next step boundary |
| `answer` | rejected until `ask_user` exists | rejected until `ask_user` exists |
| `stop` | no-op | empty the inbox; `abort()` |

- **One runner per session key.** Only the factory creates runners (a `Map` by key), so a key can
  never get two. The guarantee is per process; every command for a key must reach that process.
- **The drain never waits on a turn**: `send()` only pushes or aborts, so one drain serves every
  session and a stop arrives at once.
- **Stop never enters the inbox** — the inbox is read only at step boundaries, so a queued stop would
  wait behind a long tool. The model stream aborts at once; the shell kills its process group.
- **No lost prompts**: when a turn ends, the inbox check and the switch to idle run in one
  synchronous block. Node runs one piece of JavaScript at a time, so `push` and `splice(0)` never
  interleave.
- **Steer is a meaning, not a kind**: the same `prompt` starts a turn or steers, depending on state.
- **Replies** go through `mailroom.reply(sessionKey, text)` — never to an address from the model.
  On `turn_end`: its `answer` on `"stop"`, a one-line notice otherwise.
- **The runner holds no history**: the session's conversation lives in its loop's `AgentContext`.

## Hooks (not built yet)

Added with the first need (compaction), as optional functions on `AgentContext`, not a middleware
chain: `beforeStep` (after ②, before the model call) and `afterStep` (after ③; may end the turn).

## Verification

Fakes only at process boundaries — the `LLM` and the `Mailroom`. Loop, runners, factory and tools
run for real.

| Case | Expected |
|---|---|
| text-only response | one step, `"stop"` |
| tool call / two tool calls | results appended; two calls run in model order, one step |
| tool throws / unknown tool / invalid args | error result reaches the model, loop continues |
| model error | `"error"`, tools not run |
| model always calls a tool | `"max_steps"` |
| two steers during a tool | both in the one next model call |
| steer during the final answer | one more step |
| prompt in the same tick the turn ends | starts a new turn, not lost |
| stop during a tool | `"cancelled"`, dangling calls closed, inbox emptied |
| stop while idle | no-op |
| same key twice / two keys | same runner / two runners; the drain doesn't wait for a turn |

## Out of scope

Each added when something needs it:

- The mailroom (queue table, claiming, retries, frontend adapters) and the session module (key
  format, chat ↔ session key resolution, persisted history, compaction).
- Removing idle runners — after `/clear`, the previous session's runner stays in the factory's map.
- Concurrency limit across sessions — a scheduler in front of turn start, with pools for main and
  subagent turns. Commands are never held back, so stop and steers don't wait for a slot.
- Cron jobs and subagents — each a runner under its own key; a subagent kind is its own shared
  parts (tools, system prompt).
- `ask_user` and the `answer` command (`Question` / `QuestionAnswer` modelled on Claude Code's
  `AskUserQuestion`); per-platform button rendering.
- Kimi's step-request queue — only for ordering rules (a retry at the head). `drainSteerMessages()` is the
  seam.
- Parallel tools, streaming partial output, a grace timer for tools that ignore abort,
  cross-process routing, structured approvals for risky Azure changes.
