import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Agent } from "@mariozechner/pi-agent-core";
import { createPiAgent } from "../src/agent/agent.js";
import { tools } from "../src/agent/tools/index.js";

// Live smoke test: drives the real Lena agent (self-hosted Foundry model + managed-
// identity auth) through one short Investigate-mode chat and checks it answers.
// It hits the network, so it SKIPS when the model endpoint isn't configured rather
// than failing — run it locally with src/backend/.env populated.

// agent.ts loads .env from a build-relative path; load the backend .env here too so
// the config + credentials resolve when the test runs from source.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // No .env — rely on the ambient environment (e.g. CI secrets).
}

// The system prompt lives as Markdown; read it directly (index.ts imports it as `.js`,
// which doesn't resolve — that's a separate known issue, out of scope here).
const SYSTEM_PROMPT = readFileSync(
  new URL("../src/agent/prompt/system-prompt.md", import.meta.url),
  "utf8",
);

/** Same resolution order as loadConfig() in agent.ts — endpoint + deployment. */
function modelConfigured(): boolean {
  const endpoint =
    process.env.MICROSOFT_FOUNDRY_ENDPOINT ||
    process.env.AI_FOUNDRY_DEPLOYMENT_ENDPOINT;
  const deployment =
    process.env.MICROSOFT_FOUNDRY_DEPLOYMENT_NAME ||
    process.env.AI_FOUNDRY_DEPLOYMENT_NAME;
  return Boolean(endpoint && deployment);
}

/** Concatenated text of the last assistant message in the transcript. */
function lastAssistantText(agent: Agent): string {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
    }
  }
  return "";
}

// Skips when the Foundry model isn't configured (e.g. CI without secrets), so a
// missing endpoint yields a skip rather than a failure.
test.skipIf(!modelConfigured())(
  "inventory - how many vm do I have?",
  { timeout: 120_000 },
  async () => {
    const agent = createPiAgent({ systemPrompt: SYSTEM_PROMPT, tools });

    await agent.prompt("how many vm do I have?");
    await agent.waitForIdle();

    expect(
      agent.state.errorMessage,
      `agent turn errored: ${agent.state.errorMessage}`,
    ).toBeUndefined();

    const reply = lastAssistantText(agent);
    expect(reply.length, "expected a non-empty assistant reply").toBeGreaterThan(0);
  },
);
