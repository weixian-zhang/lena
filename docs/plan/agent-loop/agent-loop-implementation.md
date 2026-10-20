# Agent loop — implementation steps

Builds `@lena/agent` (`packages/agent`) per `agent-loop.md`. The mailroom and the session module are
black boxes: the session key is a plain string, history is in memory, and `Mailroom` is an
interface faked in tests. Each step leaves typecheck and tests green before the next starts.

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

## 1. `Toolbox.list()` in `@lena/tool` — done

## 2. Scaffold `packages/agent` (`@lena/agent`) — done

## 3. Contracts — done

- `packages/agent/types.ts`: `AgentContext`, `TurnInput`, `LoopEvent`, `TurnEndReason`,
  `AgentCommand` (each kind carries `sessionKey`; `QuestionAnswer` is a placeholder until
  `ask_user`), and `Mailroom`. Shapes are in `agent-loop.md` → Contracts.

## 4. `loop.ts` + `test/loop.test.ts` — done

- `class AgentLoop`: the constructor takes the `AgentContext`. `runTurn(turn: TurnInput)` is at the
  top, with private methods below: `streamLLM()` (forwards `LLMEvent`s, returns `done` or the
  error), `runToolCall()` (`toolbox.get`, `Value.Check`/`Value.Errors` from `typebox/value`,
  `execute(args, signal)`; any failure becomes an `isError` result) and `closeDanglingToolCalls()`.
  Every message is appended to `context.history` as it happens; `turn_end` carries the `answer`.
  The step counter and pending steers stay in `runTurn()`'s locals.
- Tests: a fake `LLM` replays one scripted event list per call and records each `LLMRequest`; real
  `Tool`s in a toolbox. `drainSteerMessages` reads an array the test pushes into from a tool's `execute()`.
- Cases: the loop rows of the verification table in `agent-loop.md`, plus abort during the stream.
  Assert on `context.history` after the turn.

## 5. `session-runner.ts` + `test/session-runner.test.ts`

- `class SessionRunner`: the constructor takes `(sessionKey, loop, mailroom)`. It holds `inbox` and
  `controller`; no history — that lives in the loop's `AgentContext`.
- `send(command)`: `stop` empties the inbox and aborts. `prompt` pushes and starts `drainInbox()` if
  idle. `answer` throws "no question is waiting".
- `drainInbox()`: while the inbox is not empty, run `loop.runTurn({ signal, drainSteerMessages })`
  and, on `turn_end`, reply with `mailroom.reply(sessionKey, answer or a one-line notice)`.
  Clear `controller` in the same synchronous block as the last inbox check.
- Tests: a fake `Mailroom` records replies. Cases: the runner rows of the verification table.

## 6. `agent-factory.ts` + `test/agent-factory.test.ts`

- `class AgentFactory`: the constructor takes `(shared: Omit<AgentContext, "history">, mailroom)`.
  It keeps a `Map<string, SessionRunner>` for `getOrCreate(sessionKey)`, which creates a runner with
  `new AgentLoop({ ...shared, history: [] })`. `drainRequests()` is
  `for await (const command of mailroom.receive()) this.getOrCreate(command.sessionKey).send(command)`.
- Tests: a fake `Mailroom` yields scripted commands. Cases: the same key reaches the same runner; two
  keys get two runners, and the drain moves on while the first turn is still running.

## 7. Finish

- `pnpm --filter @lena/agent typecheck`
- `pnpm --filter @lena/agent test`
