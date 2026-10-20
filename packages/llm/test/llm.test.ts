import type { TokenCredential } from "@azure/identity";
import { afterEach, expect, test, vi } from "vitest";
import { FoundryLLM } from "../llm.js";
import type { LLMEvent } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a Foundry deployment streams a reply into LLM events", async () => {
  // The SDK calls Foundry through the global fetch; this returns a canned reply stream instead,
  // so the test runs offline while the SDK's parser and the adapter still run for real.
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return sseResponse(REPLY_EVENTS);
    },
  );

  const llm = new FoundryLLM({
    foundryName: "lena-test",
    credential: FAKE_CREDENTIAL,
    model: "gpt-5.5",
  });

  const events: LLMEvent[] = [];
  
  for await (const event of llm.stream({
    messages: [{ role: "user", content: "Say hello." }],
    thinkingLevel: "high",
  })) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: "thinking", text: "Greeting the user." },
    {
      type: "done",
      reason: "stop",
      text: "Hello",
      thinking: "Greeting the user.",
      toolCalls: [],
      usage: { input: 3, output: 1, total: 4 },
    },
  ]);
  expect(requests[0]?.url).toBe(
    "https://lena-test.services.ai.azure.com/openai/v1/responses",
  );
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
});

// Entra sits across the network, so the credential is faked; the SDK still asks it for every token.
const FAKE_CREDENTIAL: TokenCredential = {
  getToken: async () => ({
    token: "jwt-123",
    expiresOnTimestamp: Date.now() + 3_600_000,
  }),
};

const REPLY_EVENTS = [
  {
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_1",
    output_index: 0,
    summary_index: 0,
    delta: "Greeting the user.",
    sequence_number: 1,
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 1,
    content_index: 0,
    delta: "Hello",
    sequence_number: 2,
  },
  {
    type: "response.completed",
    sequence_number: 3,
    response: {
      id: "resp_1",
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  },
];

/** A Responses API server-sent-event stream of the given events. */
function sseResponse(events: { type: string }[]): Response {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
