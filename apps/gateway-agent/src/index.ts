#!/usr/bin/env node
import { join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createPiAgent } from "@lena/agent/agent";
import { SYSTEM_PROMPT } from "@lena/agent/system-prompt";
import { tools } from "@lena/agent/tools/index";
import { initContextWindow } from "./model-catalog.js";

// Load apps/gateway-agent/.env into process.env for local development
try {
  process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
} catch {
  // No .env file present; rely on the ambient environment.
}

/**
 * Minimal entrypoint: take a single prompt (CLI args or stdin), run one agent turn,
 * and stream the assistant's text to stdout.
 *
 * This is scaffolding — the real surface (gateway, channels, sessions) attaches later
 * over a streamed event channel. Kept tiny on purpose.
 */
async function readPrompt(): Promise<string> {
  const fromArgs = process.argv.slice(2).join(" ").trim();
  if (fromArgs) return fromArgs;

  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const prompt = await readPrompt();
  if (!prompt) {
    console.error('Usage: lena "<your Azure request>"   (or pipe it via stdin)');
    process.exitCode = 1;
    return;
  }

  // Refresh the models.dev cache and pin the deployment's token budget before the loop
  // starts, so compaction can read it synchronously mid-turn.
  await initContextWindow();

  const agent = createPiAgent({
    systemPrompt: SYSTEM_PROMPT,
    tools,
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") process.stdout.write(inner.delta);
    } else if (event.type === "agent_end") {
      process.stdout.write("\n");
    }
  });

  await agent.prompt(prompt);
  await agent.waitForIdle();

  if (agent.state.errorMessage) {
    console.error(`\nLena error: ${agent.state.errorMessage}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
