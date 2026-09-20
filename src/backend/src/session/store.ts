import type {
  CompactionBoundary,
  CompactionResult,
  GetMessagesOptions,
  NewMessage,
  NewSession,
  Session,
  SessionEndReason,
  SessionPatch,
  TranscriptMessage,
} from "./types.js";

/**
 * Backend-neutral session store contract.
 *
 * One interface, two implementations: SQLite for `MODE=LOCAL`, PostgreSQL for
 * `MODE=CLOUD`. Callers depend only on this interface — the driver never leaks.
 *
 * Two tables:
 *  - Sessions: durable conversation records + the small mutable hot state
 *    (`mode`, `lastInteractionAt`). A partial unique index on `session_key WHERE
 *    ended_at IS NULL` makes this the single source of truth for the live session.
 *  - Messages: append-only transcript + in-place compaction via `compacted_by_id`
 *    (NULL = live; else the id of the summary that replaced the row).
 *
 * Implementation contract:
 *  - `appendMessages` and `compact` MUST be atomic (single transaction each).
 *  - `getMessages` MUST order by `id` (which is conversation order), never by
 *    timestamp — wall clocks can regress and scramble turns.
 *  - `getMessages` MUST exclude summaries unless asked for them, so no caller can
 *    mistake its output for a ready-to-send context.
 *  - `createSession` MUST fail if a live session already exists for the key
 *    (the partial unique index enforces this) — end the old one first to reset.
 *  - All timestamps are epoch **seconds** (float), matching the schema.
 */
export interface SessionStore {
  /** Apply the DDL for this backend if not already present. Idempotent. */
  migrate(): Promise<void>;

  // ── Sessions (durable records + live-session lookup) ────────────────────

  /** Create a new session record. `id` must be caller-minted (uuidv7). */
  createSession(input: NewSession): Promise<Session>;

  /** Fetch a session by `sessionId`, or `null` if unknown. */
  getSession(id: string): Promise<Session | null>;

  /**
   * The live session for a routing key (`ended_at IS NULL`), or `null` if none.
   * The partial unique index guarantees at most one. This is the per-message
   * "which session am I in" lookup.
   */
  getLiveSession(sessionKey: string): Promise<Session | null>;

  /** Update hot state (idle clock, mode) on the live session. */
  touchSession(id: string, patch: SessionPatch): Promise<void>;

  /** Mark a session no longer live. Idempotent; keeps the row and its transcript. */
  endSession(id: string, reason: SessionEndReason): Promise<void>;

  // ── Messages (append-only transcript) ───────────────────────────────────

  /**
   * Append messages to a session's transcript in one transaction, assigning
   * autoincrement ids. Intended to be called once per agent turn with the batch
   * from pi's `agent_end` event. Returns the persisted rows (with ids).
   */
  appendMessages(sessionId: string, messages: NewMessage[]): Promise<TranscriptMessage[]>;

  /**
   * Load transcript rows ordered by `id`. Defaults to live, non-summary rows.
   *
   * This is deliberately NOT the model context. A summary sorts last by id rather
   * than into position, so it is omitted here; the compaction module pairs this
   * with {@link SessionStore.getLiveSummary} and splices the summary in at its
   * `compactedStartId` before handing the array to the agent. Passing the raw
   * output straight to pi would silently present a summary of old history as the
   * newest turn.
   */
  getMessages(sessionId: string, opts?: GetMessagesOptions): Promise<TranscriptMessage[]>;

  /**
   * The session's live compaction summary, or `null` if it has never been
   * compacted. At most one exists — `compact` archives the previous one on every
   * run. Splice it into {@link SessionStore.getMessages} output directly *before*
   * the first row whose id is `>= summary.compactedStartId` — first-greater, not
   * equality, since the row that id names was archived by that same compaction.
   */
  getLiveSummary(sessionId: string): Promise<TranscriptMessage | null>;

  /**
   * In-place compaction of one span, atomically:
   *   1. insert `summary` as a live row marked `is_summary`, with
   *      `compacted_start_id = boundary.startId` as its splice point,
   *   2. point every other live row with `startId <= id <= endId` at it,
   *   3. point the previous live summary at it as well, if one exists.
   *
   * Both bounds are inclusive and both name rows that are destroyed — the retained
   * head sits below `startId`, the retained tail above `endId`. Live context
   * afterwards is `[head] + [summary] + [tail]`; the caller picks the bounds, the
   * store only executes them. The `sessionId` never rotates.
   *
   * Step 3 is separate from step 2 on purpose. The previous summary was written
   * after the tail it precedes, so its id can be *above* `endId` and outside the
   * span — leaving it live would put two summaries in context. Archiving it
   * unconditionally is what keeps "exactly one live summary" true, and means
   * summaries never chain.
   *
   * Rows appended between the caller computing `boundary` and this call landing
   * take the next id from the sequence, which is strictly above `endId`, so they
   * are never archived. That is what makes a range safe here where a "retain
   * these ids" list would not be.
   *
   * MUST throw (rolling back the whole transaction) if the span matches no live
   * rows, rather than leaving a summary that describes nothing. Archiving only a
   * previous summary does NOT satisfy this — the span itself must be non-empty.
   */
  compact(
    sessionId: string,
    summary: NewMessage,
    boundary: CompactionBoundary,
  ): Promise<CompactionResult>;

  /** Release any pooled connections / file handles. */
  close(): Promise<void>;
}

/**
 * Factory contract. Given the runtime mode, return the matching {@link SessionStore}.
 * Implemented in `sqlite-store.ts` / `postgres-store.ts`; selected here by `MODE`.
 */
export type CreateSessionStore = (opts: {
  mode: "LOCAL" | "CLOUD";
  /** SQLite file path (LOCAL) or Postgres connection string (CLOUD). */
  connection: string;
}) => Promise<SessionStore>;
