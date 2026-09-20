# CLAUDE.md

Guidance for Claude Code in this repo.

## What this is

Lena = Azure cloud exengineering pert agent. User chats in natural language; Lena does everything on Azure:
design, provisioning, troubleshooting (apps + config), operations (patch mgmt, monitoring, more).
End-to-end execution: resource search, data analysis, ETL, deploy, Sentinel threat hunting, etc.
**Never deletes Azure resources** — out of scope by design; decline or escalate instead.

## Tech stack

- Node.js latest (LTS/current) + TypeScript. Modern built-ins: native fetch, `node:` imports, ESM.
  Runtime code → `src/backend`.
- Agent loop = pi-agent-core's `Agent` (`new Agent({...})` in `src/backend/src/agent/agent.ts`),
  used as an npm dependency — not a hand-rolled loop. It drives the native tool_use cycle;
  `toolExecution: "sequential"`. (Still a dependency, never vendored/forked.)
- Backend-only for now. No UI code. Keep streamed event channel contract clean so frontend can
  attach later.
- Backend hosted on Azure. Config/secrets/provider selection injectable via env/config, not baked in.
  not the app language.
- Greenfield: `src/backend` empty, no package.json/build/lint/test yet. You're establishing
  conventions, not following them. Prior discarded approach: git history of
  `feat/task_runner_overseer`.

## Code comments

Keep them short — a one or two line note on the gist is enough. Comment the non-obvious "why",
not the "what"; don't restate the code or write essay-length block headers.

## TypeScript conventions

- Data structures / DTOs → `type`, not `interface`.
