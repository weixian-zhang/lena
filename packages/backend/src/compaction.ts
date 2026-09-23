// Picks the span a compaction replaces: [head] [summary] [tail].
//
// Planning only — this module decides *what* to compact. Writing the summary and
// archiving the rows is SessionStore.compact's job.

import type { AgentMessage } from "./agent/types.js";
import type { CompactionBoundary, TranscriptMessage } from "./session/types.js";
import { estimateTokens } from "./token-estimator.js";
import {
  COMPACTION_TAIL_TOKENS,
  CONTEXT_HEAD_ROOM_TOKEN,
  TOOL_RESULT_TRUNCATE_CHARS,
} from "./util/config.js";
import { getContextWindow } from "./model-catalog.js";

/** What to compact. Feed `messages` to the summarizer, `boundary` to the store. */
export type CompactionPlan = {
  /** The span to archive — inclusive on both ends, both rows destroyed. */
  boundary: CompactionBoundary;
  /** The span's payloads, tool results truncated. Input for the summary. */
  messages: AgentMessage[];
};

/**
 * Whether the assembled context has outgrown its budget.
 *
 * Compares against the deployment's window minus {@link CONTEXT_HEAD_ROOM_TOKEN} — the
 * reserve for the reply plus everything the estimator never counts (tool schemas,
 * per-request framing).
 *
 * @param contextTokens - Estimated tokens in the context about to be sent.
 */
export function shouldCompact(contextTokens: number): boolean {
  return contextTokens > getContextWindow().context - CONTEXT_HEAD_ROOM_TOKEN;
}

/**
 * Plan a compaction over a session's live transcript (ordered by id, summary excluded).
 *
 * Keeps the first message as the head — it's the user's opening ask, which frames
 * everything after it — and the newest {@link COMPACTION_TAIL_TOKENS} as the tail.
 * Everything between them is the span.
 *
 * Returns `null` when there's nothing worth compacting: the whole transcript already
 * fits in the tail, or the span collapses once a trailing tool group is pushed out.
 */
export function compact(messages: TranscriptMessage[]): CompactionPlan | null {
  const startIndex = 1; // index 0 is the head
  const endIndex = endBeforeToolGroup(messages, tailStartIndex(messages) - 1);

  const start = messages[startIndex];
  const end = messages[endIndex];
  if (endIndex < startIndex || !start || !end) return null;

  const span = messages.slice(startIndex, endIndex + 1);
  return {
    boundary: { startId: start.id, endId: end.id },
    messages: span.map((row) => truncateToolResult(row.payload)),
  };
}

/** A tool result message, derived from the transcript union rather than imported from pi. */
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

/** First index of the tail — the newest messages that fit in {@link COMPACTION_TAIL_TOKENS}. */
function tailStartIndex(messages: TranscriptMessage[]): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row) continue;
    tokens += estimateTokens(row.payload);
    if (tokens > COMPACTION_TAIL_TOKENS) return i + 1;
  }
  return 0;
}

/**
 * Pull the span's end back off a tool result.
 *
 * A tool result is meaningless without the call that produced it, so ending the span
 * mid-group would archive the call and leave orphaned results at the head of the tail.
 * Walking back to the assistant tool call and stopping *before* it moves the whole
 * group into the tail intact, at the cost of a tail slightly over budget.
 */
function endBeforeToolGroup(messages: TranscriptMessage[], endIndex: number): number {
  if (messages[endIndex]?.role !== "toolResult") return endIndex;

  let i = endIndex;
  while (i >= 0 && !isAssistantToolCall(messages[i])) i--;
  return i - 1;
}

function isAssistantToolCall(row: TranscriptMessage | undefined): boolean {
  const content = row?.payload.content;
  return (
    row?.role === "assistant" &&
    Array.isArray(content) &&
    content.some((block) => block.type === "toolCall")
  );
}

/** Tool results dominate a transcript; the summarizer only needs the gist of each. */
function truncateToolResult(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  const content = (message as ToolResultMessage).content.map((block) =>
    block.type === "text" ? { ...block, text: truncateText(block.text) } : block,
  );
  return { ...message, content } as AgentMessage;
}

/**
 * Keep the head and tail of an oversized tool result, dropping the middle.
 *
 * Both ends carry signal a head-only cut would lose: a command's output starts with
 * what it did and ends with how it finished. The kept text totals
 * {@link TOOL_RESULT_TRUNCATE_CHARS}, split evenly, plus a marker naming what went.
 */
function truncateText(text: string): string {
  if (text.length <= TOOL_RESULT_TRUNCATE_CHARS) return text;

  const half = Math.floor(TOOL_RESULT_TRUNCATE_CHARS / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n… [${omitted} chars omitted] …\n${text.slice(-half)}`;
}
