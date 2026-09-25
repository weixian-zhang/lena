import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createToolbox } from "@lena/tool";
import { createFoundryTokenProvider, createLLM, createModel } from "../index.js";
import type { FoundryAuth, LLMEvent } from "../types.js";

// Live test: hits the real Foundry endpoint with a real Entra token. It is the
// only proof that the token-as-apiKey path is accepted, so it fakes nothing.
// Self-skips when unconfigured rather than failing.

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../apps/gateway-agent/.env", import.meta.url)));
} catch {
  // No .env file present; rely on the ambient environment.
}

function configured(): boolean {
  return Boolean(
    process.env.LLM_ENDPOINT &&
      process.env.LLM_MODEL_ID &&
      process.env.AZURE_CLIENT_SECRET,
  );
}

/**
 * Build the Foundry model through createModel, so the live endpoint proves its
 * output. Foundry is an OpenAI provider under the hood, hence "openai".
 */
function foundryModel() {
  const endpoint = process.env.LLM_ENDPOINT?.replace(/\/+$/, "") ?? "";
  return createModel({
    provider: "openai",
    api: "openai-responses",
    id: process.env.LLM_MODEL_ID ?? "",
    baseUrl: endpoint.endsWith("/openai/v1") ? endpoint : `${endpoint}/openai/v1`,
  });
}

/** A live run is by definition the service-principal path. */
function servicePrincipal(): FoundryAuth {
  return {
    kind: "servicePrincipal",
    tenantId: process.env.AZURE_TENANT_ID ?? "",
    clientId: process.env.AZURE_CLIENT_ID ?? "",
    clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
  };
}

test.skipIf(!configured())("streams a reply from Foundry", { timeout: 120_000 }, async () => {
  const llm = createLLM({ model: foundryModel(), getToken: createFoundryTokenProvider(servicePrincipal()) });

  const events = await collectEvents(
    llm.stream({
      systemPrompt: "You are terse.",
      messages: [{ role: "user", content: "Count from 1 to 3." }],
    }),
  );

  const last = events.at(-1);
  if (last?.type === "error") throw new Error(`Foundry rejected the request: ${last.message}`);

  expect(last?.type).toBe("done");
  if (last?.type !== "done") return;
  expect(last.reason).toBe("stop");
  expect(last.text).toMatch(/1[\s\S]*2[\s\S]*3/);
  expect(last.usage.total).toBeGreaterThan(0);
});

test.skipIf(!configured())("asks for a tool call and accepts the result", { timeout: 120_000 }, async () => {
  const llm = createLLM({ model: foundryModel(), getToken: createFoundryTokenProvider(servicePrincipal()) });
  const tools = createToolbox([
    {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: Type.Object({ city: Type.String() }),
      execute: async () => "31 degrees and sunny",
    },
  ]);

  const asked = await collectEvents(
    llm.stream({
      tools,
      messages: [{ role: "user", content: "What is the weather in Sydney? Use the tool." }],
    }),
  );

  const call = asked.find((event) => event.type === "tool_call");
  expect(call?.type).toBe("tool_call");
  if (call?.type !== "tool_call") return;
  expect(call.call.name).toBe("get_weather");
  expect(call.call.arguments).toHaveProperty("city");

  // Feed the result back and check the model uses it.
  const answered = await collectEvents(
    llm.stream({
      tools,
      messages: [
        { role: "user", content: "What is the weather in Sydney? Use the tool." },
        { role: "assistant", content: "", toolCalls: [call.call] },
        {
          role: "toolResult",
          toolCallId: call.call.id,
          toolName: call.call.name,
          content: await tools.get(call.call.name).execute(call.call.arguments),
          isError: false,
        },
      ],
    }),
  );

  const last = answered.at(-1);
  if (last?.type === "error") throw new Error(`Foundry rejected the request: ${last.message}`);
  expect(last?.type).toBe("done");
  if (last?.type !== "done") return;
  expect(last.text).toMatch(/31/);
});

test.skipIf(!configured())("fills in every tool parameter", { timeout: 120_000 }, async () => {
  const llm = createLLM({ model: foundryModel(), getToken: createFoundryTokenProvider(servicePrincipal()) });
  const tools = createToolbox([
    {
      name: "convert_currency",
      description: "Convert an amount from one currency to another.",
      parameters: Type.Object({
        amount: Type.Number(),
        from: Type.String({ description: "ISO currency code, e.g. USD" }),
        to: Type.String({ description: "ISO currency code, e.g. AUD" }),
      }),
      execute: async () => "152.40",
    },
  ]);
  const ask = "Convert 100 USD to AUD. Use the tool.";

  const asked = await collectEvents(llm.stream({ tools, messages: [{ role: "user", content: ask }] }));

  const call = asked.find((event) => event.type === "tool_call");
  expect(call?.type).toBe("tool_call");
  if (call?.type !== "tool_call") return;
  expect(call.call.name).toBe("convert_currency");
  expect(call.call.arguments).toEqual({ amount: 100, from: "USD", to: "AUD" });

  const answered = await collectEvents(
    llm.stream({
      tools,
      messages: [
        { role: "user", content: ask },
        { role: "assistant", content: "", toolCalls: [call.call] },
        {
          role: "toolResult",
          toolCallId: call.call.id,
          toolName: call.call.name,
          content: await tools.get(call.call.name).execute(call.call.arguments),
          isError: false,
        },
      ],
    }),
  );

  const last = answered.at(-1);
  if (last?.type === "error") throw new Error(`Foundry rejected the request: ${last.message}`);
  expect(last?.type).toBe("done");
  if (last?.type !== "done") return;
  expect(last.text).toMatch(/152/);
});

/** Run a stream to completion and return everything it emitted. */
async function collectEvents(stream: AsyncGenerator<LLMEvent, void>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
