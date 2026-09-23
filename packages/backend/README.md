# Lena — backend

Azure cloud expert agent. Backend runtime built on Node.js (latest) + TypeScript (ESM).

The agent loop is the Pi mono agent core — `@mariozechner/pi-agent-core` and
`@mariozechner/pi-ai` are consumed as npm dependencies (never vendored/forked).

## Layout

    src/
      index.ts          # entrypoint: read a prompt, run one turn, stream output
      config.ts         # provider-agnostic model config from env
      agent.ts          # builds the Lena Agent (system prompt, tools, key resolution)
      system-prompt.ts  # Lena's system prompt
      tools/index.ts    # Azure tool registry (empty for now)

## Setup

    npm install
    cp .env.example .env   # fill in endpoint + key

Provider selection is entirely env-driven (see `.env.example`); nothing is baked in.

## Run

    npm run dev -- "List my resource groups in the eastus region"
    # or
    echo "What can you do?" | npm start

## Scripts

- `npm run dev` — run with tsx + watch
- `npm start` — run once with tsx
- `npm run build` — compile to `dist/`
- `npm run typecheck` — type-check without emitting
