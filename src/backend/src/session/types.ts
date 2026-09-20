import type { AgentMessage, AgentMode } from "../agent/types.js";
import type { InboundMessage } from "../gateway/types.js";

/**
 * Domain types for the session store.
 *
 * Two tables:
 *  - `sessions` — one durable record per conversation (a `sessionId`), plus the
 *    small amount of mutable hot state (mode, idle clock). A partial unique index
 *    on `session_key WHERE ended_at IS NULL` makes it the single source of truth
 *    for "which session is live" — no separate routing table to keep in sync.
 *  - `messages` — append-only transcript, one row per {@link AgentMessage}.
 *
 * The runtime (pi-agent-core) never sees these types directly: a session is
 * hydrated by loading `messages` for the live `sessionId` and passing them as
 * `initialState.messages`, and persisted by appending new messages per turn.
 */

/** Backend selection. Sourced from the `MODE` env var (`LOCAL` → SQLite, `CLOUD` → Postgres). */
export type StoreMode = "LOCAL" | "CLOUD";

/**
 * Transcript row role. Mirrors pi's {@link AgentMessage} base roles; a compaction
 * summary is stored as an ordinary message row (a live row that other, older rows
 * now point at via `compactedById`), distinguished only by `isSummary`.
 *
 * A summary is written as `assistant` — it reads as Lena recounting the omitted
 * span. This does not guarantee strict role alternation: retaining a tool-call
 * pair can make the first tail row an `assistant` message too, putting two in a
 * row. The OpenAI-compatible Foundry endpoint accepts that.
 */
export type MessageRole = "user" | "assistant" | "toolResult";

/**
 * Why a session stopped being the live one for its key. Terminal vs recoverable
 * is a property of this enum: `manual`, `idle_timeout`, and `daily_reset` mint a
 * *fresh* successor under the same key; `agent_close` is bookkeeping.
 */
export type SessionEndReason =
  | "manual" // user asked for a new session (e.g. /new)
  | "idle_timeout" // no interaction past the idle window
  | "daily_reset" // crossed the daily reset hour
  | "agent_close"; // process/gateway shut the session down

/**
 * A durable conversation record. `id` is the `sessionId` referenced everywhere
 * else. Carries the small mutable hot state (`mode`, `lastInteractionAt`) inline
 * — updated per turn via {@link SessionStore.touchSession}.
 */
export type Session = {
  /** uuidv7, caller-minted. Doubles as the transcript's foreign key. */
  id: string;
  /** Routing key this session was created for. At most one live session per key. */
  sessionKey: string;
  source: InboundMessage;
  /** Current conversational mode; `null` until set. */
  mode: AgentMode | null;
  /** Start of this session — drives the daily reset. */
  startedAt: number;
  /** Last real user turn — drives the idle reset. Not bumped by cron/system turns. */
  lastInteractionAt: number;
  /** Set when this session is no longer live; `null` while live. */
  endedAt: number | null;
  endReason: SessionEndReason | null;
};

/** Input to {@link SessionStore.createSession}. Store fills defaults for omitted fields. */
export type NewSession = {
  id: string;
  sessionKey: string;
  source: InboundMessage;
  mode?: AgentMode;
  /** Defaults to now (epoch seconds); also seeds `lastInteractionAt`. */
  startedAt?: number;
};

/** Fields {@link SessionStore.touchSession} may update on the live session. */
export type SessionPatch = {
  lastInteractionAt?: number;
  mode?: AgentMode;
};

/**
 * A persisted transcript row. `id` is both insertion order and conversation
 * order — see {@link TranscriptMessage.id} for the single exception.
 */
export type TranscriptMessage = {
  /**
   * Autoincrement id. Doubles as the conversation-order key and is the target of
   * `compactedById`.
   *
   * Every ordinary append satisfies both meanings at once. A compaction summary
   * is the one row where they disagree: it is written *after* the tail it
   * logically precedes, so it always carries the highest id. Sorting by `id`
   * therefore places the summary last, not between head and tail — which is why
   * it is excluded from {@link SessionStore.getMessages} and repositioned by the
   * compaction module using {@link TranscriptMessage.compactedStartId}.
   */
  id: number;
  sessionId: string;
  /** Denormalized from `payload.role` for cheap filtering. */
  role: MessageRole;
  /** The full pi message, round-tripped losslessly (stored as JSON in `content`). */
  payload: AgentMessage;
  /**
   * True for a compaction summary. At most one summary is live at a time — a new
   * compaction archives the previous one unconditionally — so this doubles as the
   * lookup for "the summary currently in context" ({@link SessionStore.getLiveSummary}).
   */
  isSummary: boolean;
  /**
   * Splice point, summary rows only (`null` otherwise): the id the replaced span
   * started at ({@link CompactionBoundary.startId}). Carries the position that
   * `id` cannot, so the compaction module can rebuild `[head] [summary] [tail]`
   * without inferring anything from the head's size.
   *
   * Splice by *first-greater*, not equality — insert the summary before the first
   * live row whose `id >= compactedStartId`. The row this id names was archived by
   * this very compaction, so it is not in the live set to match against. This also
   * lands correctly when the head or the tail is empty.
   *
   * Deliberately not paired with an `endId` column: this is a splice point, not
   * lineage. `compactedById` is the exact record of what was archived, and a stored
   * range would misdescribe it — a folded-in previous summary sits above `endId`.
   */
  compactedStartId: number | null;
  /**
   * Liveness + compaction lineage in one field:
   *  - `null` → live (in the context window; `WHERE compacted_by_id IS NULL` reconstructs it).
   *  - `<id>` → summarized away; the id of the summary message that replaced this row.
   * See {@link SessionStore.compact}.
   */
  compactedById: number | null;
  createdAt: number;
};

/** Input to {@link SessionStore.appendMessages} / {@link SessionStore.compact}. */
export type NewMessage = {
  role: MessageRole;
  payload: AgentMessage;
  /** Defaults to now (epoch seconds). */
  createdAt?: number;
};

/** Options for {@link SessionStore.getMessages}. */
export type GetMessagesOptions = {
  /** Include compacted (`compacted_by_id IS NOT NULL`) rows. Default `false` → live rows only. */
  includeInactive?: boolean;
  /**
   * Include compaction summaries. Default `false`, because a summary's id sorts
   * it last rather than into position — see {@link SessionStore.getMessages}.
   * Only set this for audit/replay reads that don't feed the model.
   */
  includeSummaries?: boolean;
  /** Max rows to return, ordered by `id`. */
  limit?: number;
  /** Rows to skip (pagination). */
  offset?: number;
};

/**
 * The span {@link SessionStore.compact} replaces. **Inclusive on both ends, and
 * both ends name rows that are destroyed** — `startId` is the first compacted
 * message, `endId` the last. The retained head sits below `startId` and the
 * retained tail above `endId`; neither bound touches them.
 *
 * ```
 * ids:    1      2  3  4  5  6      7 ...
 *       [head] [ compacted span ] [tail]
 *              startId=2  endId=6         → archive WHERE id >= 2 AND id <= 6
 * ```
 *
 * `startId` is also stored on the summary row as its splice point — see
 * {@link TranscriptMessage.compactedStartId}. It cannot be derived from the head's
 * id: `messages.id` is a table-wide sequence, so a session's ids are sparse and
 * `startId - 1` is not necessarily (or even usually) the head row.
 *
 * The range does *not* cover a previous summary: that row was written after the
 * tail it precedes, so its id can fall above `endId`. `compact` archives it
 * explicitly rather than relying on the bounds to catch it.
 */
export type CompactionBoundary = {
  /** Inclusive lower bound — the id of the first message compacted away. */
  startId: number;
  /** Inclusive upper bound — the id of the last message compacted away. */
  endId: number;
};

/** Result of a {@link SessionStore.compact} call. */
export type CompactionResult = {
  /**
   * How many previously-live rows were summarized away (pointed at the summary):
   * the in-span rows plus the previous summary, if there was one.
   */
  archivedCount: number;
  /** The freshly inserted summary row. Its `compactedStartId` is where it belongs in context. */
  summary: TranscriptMessage;
};
