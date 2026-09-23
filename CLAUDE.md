# CLAUDE.md

Guidance for Claude Code in this repo.

## What this is

Lena = Azure cloud engineering expert agent. The user chats in natural language; Lena executes on
Azure end to end: design, provisioning, troubleshooting (apps + config), operations (patching,
monitoring), resource search, data analysis, ETL, deploy, Sentinel threat hunting.
**Never deletes Azure resources** — out of scope by design; decline or escalate instead.

## Tech stack

- Node.js latest + TypeScript, ESM. Modern built-ins: native fetch, `node:` imports.
  Runtime code → `packages/backend`.
- Agent loop = pi-agent-core's `Agent` (`packages/backend/src/agent/agent.ts`), used as an npm
  dependency — never hand-rolled, vendored or forked. It drives the native tool_use cycle with
  `toolExecution: "sequential"`.
- Backend only, no UI. Keep the streamed event contract clean so a frontend can attach later.
- Hosted on Azure. Config, secrets and provider selection are injected via env/config, never
  baked in.
- Prior discarded approach: git history of `feat/task_runner_overseer`.

## Code comments

One or two lines, never more than three. Explain the non-obvious "why", not the "what".

## Naming

Function names say what the function does. Longer is fine when it carries the meaning.

## Scope

Build what was asked and nothing beyond it. Keep implementations simple and concise.

## File layout

Exported functions and types at the top, private helpers at the bottom.

## TypeScript conventions

- Data structures / DTOs → `type`, not `interface`.
