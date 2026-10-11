import { afterEach, expect, test, vi } from "vitest";
import { PiAiLLM } from "../index.js";
import type { ModelConfig, ProviderConfig } from "../provider-config.js";
import type { LLMEvent } from "../types.js";

// Entra and Foundry sit across the network, so they are the only fakes.
vi.mock("@azure/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@azure/identity")>()),
  getBearerTokenProvider: () => async () => "jwt-123",
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a provider config streams a reply into LLM events", async () => {

  vi.stubGlobal("fetch", async () => sseResponse(REPLY_CHUNKS));

  const model: ModelConfig = {
    id: "DeepSeek-V4-Pro",
    api: "openai-completions",
    contextWindow: 128_000,
    maxTokens: 8_000,
    tools: true,
  };

  const provider: ProviderConfig = {
    kind: "foundry",
    resource: "lena-test",
    auth: { kind: "managedIdentity" },
    models: [model],
  };

  const llm = new PiAiLLM("foundry-test", provider, model);
  
  const events: LLMEvent[] = [];
  
  for await (const event of llm.stream({
    messages: [{ role: "user", content: "Say hello." }],
  }))
    events.push(event);

  expect(events).toEqual([
    {
      type: "done",
      reason: "stop",
      text: "Hello",
      toolCalls: [],
      usage: { input: 3, output: 1, total: 4 },
    },
  ]);
});

const REPLY_CHUNKS = [
  {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "DeepSeek-V4-Pro",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Hello" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "DeepSeek-V4-Pro",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  },
];

/** A Chat Completions server-sent-event stream of the given chunks. */
function sseResponse(chunks: object[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
