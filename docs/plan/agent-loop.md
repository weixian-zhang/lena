# Agent loop — Lena's own `turn()` / `step()`

## Goal

Lena owns its agent loop: a `while` loop split into `turn()` (one user-facing turn) and
`step()` (one model call plus its tools), with steering, stop, and replies on the platform the
user wrote from. One loop runs per session.

- Model calls go through `LLM.stream()` (`packages/agent/llm`); pi-ai is transport only.
- Tools are `Tool` / `Toolbox` from `@lena/tool`.
- Not pi-agent-core's `Agent`. `packages/agent/agent.ts` wraps it only until this loop replaces it.

## Layout

```
packages/agent/loop/
  types.ts           LoopOptions, LoopEvent, TurnEndReason
  turn.ts            turn(), step(), runToolCall()
  session-runner.ts  SessionRunner — inbox, reply address, stop, next-turn start
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

## Session key

```
agent:<agentId>:<channel>:<chatType>:<chatId>[:thread:<threadId>]    agentId = main
agent:cron:<jobId>
agent:subagent:<parentSessionId>:<ulid>
```

- `agentId` names the kind of agent: `main` handles chats, `cron` runs a scheduled job,
  `subagent` is spun off by another agent. The gateway's current `InboundMessage`
  (`packages/gateway/types.ts`) already carries `agentId`.
- One gateway function, `buildSessionKey(...)`, builds it, so the same chat always yields the
  same key and `AgentFactory` finds the running agent.
- Each segment is URI-encoded and case is kept: Teams ids contain `:`, and lowercasing broke
  case-sensitive ids in OpenClaw.
- The key is identity, not the reply address. The ULID is the **session id** in the session
  store; `/new` ends the session and starts a new ULID under the same key.

## Reply address and commands

The agent replies to the reply address of the user's latest command — never one from the model,
and never parsed out of the key (OpenClaw's lesson: the key is identity, the address is stored).

```ts
/** Where a reply goes: channel, chat and thread. Set by the channel adapter, never by the model. */
type ReplyAddress = { channel: string; chatType: ChatType; chatId: string; threadId?: string; userId?: string };

/**
 * What the gateway hands an agent: what the user did, not what it means — the agent decides that
 * from its state. History is not carried; the agent loads it by session key.
 */
type AgentCommand =
  | { kind: "prompt"; prompt: string; replyAddress: ReplyAddress }
  | { kind: "answer"; questionId: string; answers: QuestionAnswer[]; replyAddress: ReplyAddress }
  | { kind: "stop" };

/** Channel adapters behind one interface; each keeps its platform references (Teams serviceUrl, tenantId). */
interface Outbound {
  send(address: ReplyAddress, text: string): Promise<void>;
}
```

- A command's `replyAddress` becomes the agent's **reply address**, so a new thread or chat
  detail is picked up by the next reply. Tools that ask the user send to it too.
- The agent sends each turn's final answer with `outbound.send(replyAddress, text)`.
- A cron job's address comes from its job definition. A subagent has none — it answers its
  parent through its tool result.
- **Steer is a meaning, not a kind.** The same `prompt` starts a turn or steers, depending on the
  agent's state. A separate `steer` kind would only be needed if the user chose "steer now" vs
  "run next" (Kimi's Ctrl+S); the sender can't know the agent's state, and both mismatches resolve
  to `prompt`'s behaviour.

**Where the types live**

- `ReplyAddress`, `ChatType` and `Outbound` in `packages/gateway/types.ts`; `AgentCommand` in
  `packages/agent/loop/types.ts`, importing them.
- `@lena/gateway` stays types-only, a leaf every package can import. The gateway server and
  channel adapters call `AgentFactory`, so they live outside it (e.g. `apps/gateway-agent`), or
  `gateway` → `agent` → `gateway` forms a cycle.
- The existing `InboundMessage` there overlaps `ReplyAddress` (channel, chatType, chatId, userId);
  build it from `ReplyAddress` instead of repeating the fields.

**Questions the agent asks** — modelled on Claude Code's `AskUserQuestion`. One shape covers
every answer format, so there is no per-format type:

```ts
/** One of 1–4 questions in a set; each is a category with its own choices. */
type Question = {
  header: string;                                        // short category label, e.g. "Region"
  question: string;
  options: { label: string; description?: string }[];    // 2–4
  multiSelect: boolean;
};

/** One answer per question: the chosen labels, and/or free text ("Other"). */
type QuestionAnswer = { header: string; selected: string[]; otherText?: string };
```

| Answer format | Expressed as |
|---|---|
| free text | a typed reply (`prompt`), or `otherText` |
| one multiple choice | one question, `multiSelect: false` |
| several categories, each a multiple choice | several questions, one per category |

Platforms without buttons (plain Slack or Telegram text) render the options as a numbered list;
the typed reply arrives as a `prompt`.

## Sessions, steering and stop

`AgentFactory` creates agents and finds existing ones by session key — one class, because every
command needs "find or create" and two places would have to agree on it.

```ts
interface SessionRunner {
  /**
   * prompt — idle: start a turn; running: steer; question waiting: free-text answer.
   * answer — resolves the waiting question with a matching id. stop — abort, empty the inbox.
   */
  submit(command: AgentCommand): void;
}

/** The session runners in this process, one per session key. */
interface AgentFactory {
  /** The runner for `sessionKey`, created on first use. */
  getOrCreate(sessionKey: string): SessionRunner;
}
```

- The factory only finds or creates. It never enqueues: whether a command starts a turn, becomes
  a steer or aborts depends on the agent's state, so each agent owns its inbox.
- The constructor takes what every agent shares (`LLM`, shared tools, system prompt,
  `Outbound`), so `getOrCreate` needs only the key.
- The gateway routes every kind the same way: `factory.getOrCreate(key).submit(command)`. A stop
  for an unknown key creates an idle runner, which does nothing.
- It knows only this process's runners; finding a key's owner across instances is routing.

An `AgentCommand` carries an explicit kind set by the channel or UI, never guessed from the text.
The runner handles each one on arrival:

| Arrives | Idle | Turn running | Question waiting |
|---|---|---|---|
| `prompt` | start a turn | steer — push onto the inbox | free-text answer |
| `answer` | rejected — no question | rejected — no question | answers it if `questionId` matches; a stale id is rejected |
| `stop` | no-op, reported | empty the inbox, `abort()` | `abort()` — the question is cancelled |

- **One queue: the inbox.** Stop never enters it — the inbox is read only at step boundaries, so
  a queued stop would wait behind a long tool.
- **Typed text answers a waiting question.** Plain chat replies can't carry a `questionId`, and the
  loop is blocked in the tool, so a steer would have nowhere to land. Buttons and forms send
  `answer` with the id, which guards against answering a stale question.
- **No step-level queue.** Without retries or hooks, "tools were called, go again" is the `while`
  condition. Kimi Code's prompt queue and step request queue are not adopted.
- **Where a steer lands:** after the current step's tool results, before the next model call.
  A steer during the final answer runs one more step. Remaining tool calls are not skipped.
- **No lost prompts.** When a turn ends, the inbox check and the switch to idle run in one
  synchronous block. Leftover prompts start the next turn — except after a stop.
- **Stop latency.** The model stream aborts at once; `bash` kills its process tree. A tool that
  ignores the signal delays the stop until it returns.
- **One owner per session key.** The inbox is in memory, so a session key must be owned by one
  process, and every command must route to it.

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
| prompt with a new `threadId` | the next reply goes to the new address |
| same chat, two prompts | same key, same agent |

## Out of scope

Each added when something needs it:

- Session persistence and compaction — the agent loads history by session key; commands never
  carry it.
- Removing idle runners from `AgentFactory` — a runner holds its history in memory, so removal
  waits for persistence.
- Early termination — a tool result that ends the turn.
- Parallel tool execution; streaming partial tool results.
- A grace timer for tools that ignore the abort signal.
- Cross-process routing of a session key (sticky routing or Azure Service Bus sessions).
- `ask_user`, the `answer` command and per-platform button rendering — built together later.
  The command type above is final, so it doesn't change shape then.
- Structured approvals for risky Azure changes (`outbound-message-type-design.md`).
- Streaming partial output to the desktop app.
