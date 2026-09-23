import { afterEach, expect, test, vi } from "vitest";
import { compact, shouldCompact } from "../src/compaction.js";
import { CONTEXT_HEAD_ROOM_TOKEN, TOOL_RESULT_TRUNCATE_CHARS } from "../src/util/config.js";
import type { AgentMessage } from "../src/agent/types.js";
import type { TranscriptMessage } from "../src/session/types.js";

// Offline: no catalogue fetch — shouldCompact reads the default window when init never ran.

let nextId = 1;

/** A transcript row whose payload estimates to roughly `tokens`. */
function row(role: TranscriptMessage["role"], payload: AgentMessage): TranscriptMessage {
  return {
    id: nextId++,
    sessionId: "s",
    role,
    payload,
    isSummary: false,
    compactedStartId: null,
    compactedById: null,
    createdAt: 0,
  };
}

/** ~4 chars per token, so `tokens * 4` characters. */
function text(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function user(tokens: number): TranscriptMessage {
  return row("user", { role: "user", content: text(tokens), timestamp: 0 } as AgentMessage);
}

function assistant(tokens: number): TranscriptMessage {
  return row("assistant", {
    role: "assistant",
    content: [{ type: "text", text: text(tokens) }],
  } as unknown as AgentMessage);
}

function toolCall(): TranscriptMessage {
  return row("assistant", {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
  } as unknown as AgentMessage);
}

function rawToolResult(body: string): TranscriptMessage {
  return row("toolResult", {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: body }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage);
}

function toolResult(tokens: number): TranscriptMessage {
  return rawToolResult(text(tokens));
}

afterEach(() => {
  nextId = 1;
  vi.restoreAllMocks();
});

test("shouldCompact fires only past the window minus headroom", () => {
  // No init has run, so the conservative 200_000 default applies.
  const budget = 200_000 - CONTEXT_HEAD_ROOM_TOKEN;

  expect(shouldCompact(budget)).toBe(false);
  expect(shouldCompact(budget + 1)).toBe(true);
});

test("returns null when the whole transcript fits in the tail", () => {
  expect(compact([user(10), assistant(10), user(10)])).toBeNull();
});

test("keeps the head, compacts the middle, keeps the tail", () => {
  const messages = [
    user(10),
    assistant(7_000),
    assistant(7_000),
    assistant(7_000),
    assistant(7_000),
    user(10),
  ];

  const plan = compact(messages);

  // Tail is the newest ≤20K: two assistants plus the closing user. Head is id 1.
  expect(plan?.boundary).toEqual({ startId: 2, endId: 3 });
  expect(plan?.messages).toHaveLength(2);
});

test("never splits a tool call from its results", () => {
  // The span would otherwise end on the tool result (id 4), archiving the call that
  // produced it and leaving the result orphaned at the head of the tail.
  const messages = [user(10), assistant(10), toolCall(), toolResult(25_000), user(10)];

  const plan = compact(messages);

  // Call (id 3) and result (id 4) move into the tail together; the span stops at 2.
  expect(plan?.boundary).toEqual({ startId: 2, endId: 2 });
});

test("returns null when pushing out the tool group empties the span", () => {
  const messages = [user(10), toolCall(), toolResult(30_000), user(10)];

  expect(compact(messages)).toBeNull();
});

/** The text of the first content block of a planned message. */
function blockText(plan: ReturnType<typeof compact>, index: number): string {
  const content = plan?.messages[index]?.content;
  const block = Array.isArray(content) ? content[0] : undefined;
  return block && "text" in block ? block.text : "";
}

test("keeps the head and tail of an oversized tool result", () => {
  // A result whose start and end differ, so a head-only cut would be visible.
  const body = `START${"x".repeat(50_000)}END`;
  const messages = [user(10), toolCall(), rawToolResult(body), assistant(25_000), user(10)];

  const plan = compact(messages);
  const text = blockText(plan, 1);
  const half = TOOL_RESULT_TRUNCATE_CHARS / 2;

  expect(plan?.boundary).toEqual({ startId: 2, endId: 4 });
  expect(text.startsWith("START")).toBe(true);
  expect(text.endsWith("END")).toBe(true);
  expect(text).toContain(`[${body.length - TOOL_RESULT_TRUNCATE_CHARS} chars omitted]`);
  // Kept content is exactly the budget, split evenly; the marker sits on top.
  expect(text.replace(/\n… \[\d+ chars omitted\] …\n/, "")).toHaveLength(half * 2);
});

test("leaves a tool result under the budget untouched", () => {
  const body = "short output";
  const messages = [user(10), toolCall(), rawToolResult(body), assistant(25_000), user(10)];

  expect(blockText(compact(messages), 1)).toBe(body);
});
