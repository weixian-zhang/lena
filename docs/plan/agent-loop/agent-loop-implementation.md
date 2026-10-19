# Agent loop — implementation steps

Builds `@lena/agent-loop`: `runTurn()` (a `while` over steps, no step queue), `SessionRunner` (one
per session key, inbox, `send()`), and `AgentFactory` (drains the mailroom). The mailroom and the
session module are black boxes: the session key is a plain string, history is in memory, and
`Mailroom` is an interface faked in tests.

Each step leaves typecheck and tests green before the next starts.

## 1. `Toolbox.list()` in `@lena/tool` — done

- `packages/tool/toolbox.ts`: add `list(): readonly Tool[]` to `Toolbox`, and implement it in
  `StandardToolbox` as `[...this.toolsByName.values()]`, which keeps insertion order.
- `packages/tool/test/toolbox.test.ts`: add a case checking that the tools come back in the order given.

## 2. Scaffold `packages/agent-loop`

- `package.json`: copy the `packages/llm/package.json` shape. Name `@lena/agent-loop`; deps
  `@lena/llm`, `@lena/tool`, `@lena/gateway` (all `workspace:*`), `typebox` `^1.3.7`; dev deps
  `typescript`, `vitest`, `@types/node`.
- `tsconfig.json`: copy `packages/llm/tsconfig.json`.
- `index.ts`: re-exports. Then run `pnpm install`.

## 3. Contracts

- `packages/gateway/types.ts`: add `ReplyAddress`. Leave `InboundMessage` untouched; the session
  store still uses it.
- `packages/agent-loop/types.ts`: `LoopOptions`, `LoopEvent`, `TurnEndReason`, `AgentCommand`
  (`answer` uses a placeholder `QuestionAnswer` type until `ask_user`), `AgentRequest`
  (`{ sessionKey, command }`), and `Mailroom` (`receive(): AsyncIterable<AgentRequest>`,
  `reply(address, text)`). `Mailroom` is defined here so the future mailroom package can implement
  it without an import cycle.

## 4. `run-turn.ts` + `test/run-turn.test.ts`

- `runTurn()` exported at the top. Private helpers below: `streamModelCall()` (forwards `LLMEvent`s and
  returns `done` or the error), `runToolCall()` (`toolbox.get`, typebox `Value.Check`/`Value.Errors`
  from `typebox/value`, `execute(args, signal)`; any failure becomes an `isError` toolResult), and
  `closeDanglingToolCalls()`.
- Tests: a fake `LLM` replays one scripted event list per call and records each `LLMRequest`, so a
  test can assert what the next model call saw. Real in-process `Tool`s in a `StandardToolbox`.
  `takeSteers` reads a plain array the test pushes into from inside a tool's `execute()`.
- Cases: text-only → one step `"stop"`; tool call → second model call; two tool calls in model order,
  one step; tool throws / unknown tool / invalid args → error result, loop continues; model error →
  `"error"`, no tools run; always calls a tool → `"max_steps"`; two steers during a tool → both in the
  one next model call; steer during the final answer → one more step; abort during a tool →
  `"cancelled"` with dangling calls closed; abort during the stream → `"cancelled"`.

## 5. `session-runner.ts` + `test/session-runner.test.ts`

- `class DefaultSessionRunner implements SessionRunner`. Constructor takes the shared parts (`LLM`,
  `Toolbox`, system prompt, `Mailroom`). It holds `inbox`, `history`, `replyAddress` and `controller`.
- `send()`: for `stop`, empty the inbox and abort. For `prompt`, set `replyAddress`, push, and start
  `drainInbox()` if idle. For `answer`, throw "no question is waiting" (never default silently).
- `drainInbox()`: `while (inbox.length > 0)`, run one turn. Append the returned messages to
  `history`, then reply through `mailroom.reply`: the final answer on `"stop"`, and a one-line notice
  otherwise. Clear `controller` in the same synchronous block as the last inbox check.
- Tests: a fake `Mailroom` records replies. Cases: a steer during a tool; stop during a tool empties
  the inbox; stop while idle is a no-op; a prompt in the same tick the turn ends starts a new turn; a
  prompt with a new `threadId` moves the next reply to the new address.

## 6. `agent-factory.ts` + `test/agent-factory.test.ts`

- `class DefaultAgentFactory implements AgentFactory`: a `Map<string, SessionRunner>` for
  `getOrCreate`. `drainRequests()` is
  `for await (const request of mailroom.receive()) this.getOrCreate(request.sessionKey).send(request.command)`.
- Tests: a fake `Mailroom` whose `receive()` yields scripted requests. Cases: the same key reaches the
  same runner; two keys get two runners, and the drain moves on while the first turn is still running.

## 7. Finish

- `pnpm --filter @lena/tool test`
- `pnpm --filter @lena/agent-loop typecheck`
- `pnpm --filter @lena/agent-loop test`
