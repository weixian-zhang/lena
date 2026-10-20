import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTokenCredential, FoundryLLM, type LLM } from "@lena/llm";
import { SystemConfig } from "@lena/system-config";
import { StandardToolbox, type Toolbox } from "@lena/tool";
import { describe, expect, test } from "vitest";
import type { AgentContext, LoopEvent } from "../types.js";
import {
  countSteps,
  createContext,
  drainOnce,
  runAgentLoop,
  user,
} from "./helpers.js";

// Calls the real Foundry deployment from the repo `.env`; skipped where none is configured.
describe.skipIf(!loadFoundryEnv())("steps and tools", () => {
  test(
    "a text-only response is one step that ends with the answer",
    { timeout: 300_000 },
    async () => {
      const llm: LLM = new LocalDevFoundryLLM();
      const context: AgentContext = {
        ...createContext(llm, []),
        toolbox: createLocalDevToolbox(),
      };

      const events: LoopEvent[] = await runAgentLoop(context, {
        drainSteerMessages: drainOnce([
          user("Reply with the single word: pong"),
        ]),
      });

      const answer: string = answerOf(events);
      expect(countSteps(events)).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "stop" });
      expect(answer.toLowerCase()).toContain("pong");
      expect(context.history).toEqual([
        user("Reply with the single word: pong"),
        { role: "assistant", content: answer },
      ]);
    },
  );
});

/** The real Foundry deployment named in the repo `.env`, signed in as its service principal. */
class LocalDevFoundryLLM extends FoundryLLM {
  constructor() {
    super({
      foundryName: requireEnv("FOUNDRY_NAME"),
      model: requireEnv("FOUNDRY_DEPLOYMENT_NAME"),
      credential: createTokenCredential({
        kind: "servicePrincipal",
        tenantId: requireEnv("AZURE_TENANT_ID"),
        clientId: requireEnv("AZURE_CLIENT_ID"),
        clientSecretEnv: "AZURE_CLIENT_SECRET",
      }),
    });
  }
}

/** Lena's built-in tools in the configured working directory, with `az` signed in as the `.env` service principal. */
function createLocalDevToolbox(): Toolbox {
  return new StandardToolbox(SystemConfig.global().cwd, {
    kind: "servicePrincipal",
    tenantId: requireEnv("AZURE_TENANT_ID"),
    clientId: requireEnv("AZURE_CLIENT_ID"),
    clientSecret: requireEnv("AZURE_CLIENT_SECRET"),
  });
}

/** Loads the repo `.env` when present; true when it names a Foundry resource to call. */
function loadFoundryEnv(): boolean {
  const envFile: string = fileURLToPath(
    new URL("../../../.env", import.meta.url),
  );
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  return Boolean(process.env.FOUNDRY_NAME);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set.`);

  return value;
}

function answerOf(events: LoopEvent[]): string {
  const turnEnd: LoopEvent | undefined = events.at(-1);
  if (turnEnd?.type !== "turn_end" || turnEnd.answer === undefined)
    throw new Error(
      `The turn ended without an answer: ${JSON.stringify(turnEnd)}.`,
    );

  return turnEnd.answer;
}
