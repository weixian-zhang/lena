import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { PoolClient } from "pg";
import type { AgentMessage, AgentMode } from "../agent/types.js";
import type { InboundMessage } from "../gateway/types.js";
import type { SessionStore } from "./store.js";
import type {
  CompactionBoundary,
  CompactionResult,
  GetMessagesOptions,
  MessageRole,
  NewMessage,
  NewSession,
  Session,
  SessionEndReason,
  SessionPatch,
  TranscriptMessage,
} from "./types.js";

const { Pool } = pg;

/** Epoch seconds (float), matching the schema's DOUBLE PRECISION timestamps. */
function nowSec(): number {
  return Date.now() / 1000;
}

/** Postgres flags a unique-index conflict with SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === "23505";
}

/**
 * Raw `sessions` row. Note node-postgres returns DOUBLE PRECISION as a JS number
 * but leaves `source`/`mode` as text for us to parse.
 */
type SessionRow = {
  id: string;
  session_key: string;
  source: string;
  mode: string | null;
  started_at: number;
  last_interaction_at: number;
  ended_at: number | null;
  end_reason: string | null;
};

/**
 * Raw `messages` row. `id`, `compacted_start_id` and `compacted_by_id` are BIGINT,
 * which node-postgres returns as *strings* (to avoid silent precision loss) —
 * normalized in toMessage. `is_summary` is SMALLINT (0/1) to match SQLite.
 */
type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
  is_summary: number;
  compacted_start_id: string | null;
  created_at: number;
  compacted_by_id: string | null;
};

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    sessionKey: r.session_key,
    source: JSON.parse(r.source) as InboundMessage,
    mode: r.mode as AgentMode | null,
    startedAt: r.started_at,
    lastInteractionAt: r.last_interaction_at,
    endedAt: r.ended_at,
    endReason: r.end_reason as SessionEndReason | null,
  };
}

function toMessage(r: MessageRow): TranscriptMessage {
  return {
    id: Number(r.id),
    sessionId: r.session_id,
    role: r.role as MessageRole,
    payload: JSON.parse(r.content) as AgentMessage,
    isSummary: r.is_summary === 1,
    compactedStartId: r.compacted_start_id === null ? null : Number(r.compacted_start_id),
    compactedById: r.compacted_by_id === null ? null : Number(r.compacted_by_id),
    createdAt: r.created_at,
  };
}

/**
 * PostgreSQL {@link SessionStore} (MODE=CLOUD), backed by node-postgres.
 *
 * Semantically identical to the SQLite store; the differences are all driver
 * shape: async I/O, `$n` placeholders, `RETURNING id` for generated keys, and
 * real BEGIN/COMMIT transactions (on a single checked-out client) for the two
 * atomic writes — `appendMessages` and `compact`.
 */
export class PostgresSessionStore implements SessionStore {
  private readonly pool: pg.Pool;

  constructor(connection: string) {
    this.pool = new Pool({ connectionString: connection });
  }

  /** Run `fn` inside a single-client transaction, rolling back on any throw. */
  private async withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    // Multi-statement DDL runs via the simple query protocol (no params).
    const ddl = readFileSync(join(import.meta.dirname, "schema", "postgres.sql"), "utf8");
    await this.pool.query(ddl);
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async createSession(input: NewSession): Promise<Session> {
    const startedAt = input.startedAt ?? nowSec();
    const mode = input.mode ?? null;
    try {
      // $5 reused: started_at and last_interaction_at seed to the same value.
      await this.pool.query(
        `INSERT INTO sessions
           (id, session_key, source, mode, started_at, last_interaction_at, ended_at, end_reason)
         VALUES ($1, $2, $3, $4, $5, $5, NULL, NULL)`,
        [input.id, input.sessionKey, JSON.stringify(input.source), mode, startedAt],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(
          `Cannot create session: a live session already exists for key "${input.sessionKey}" ` +
            `(or id "${input.id}"). End the existing one first.`,
        );
      }
      throw err;
    }
    return {
      id: input.id,
      sessionKey: input.sessionKey,
      source: input.source,
      mode,
      startedAt,
      lastInteractionAt: startedAt,
      endedAt: null,
      endReason: null,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    const res = await this.pool.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
    const row = res.rows[0] as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async getLiveSession(sessionKey: string): Promise<Session | null> {
    const res = await this.pool.query(
      `SELECT * FROM sessions WHERE session_key = $1 AND ended_at IS NULL`,
      [sessionKey],
    );
    const row = res.rows[0] as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async touchSession(id: string, patch: SessionPatch): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.lastInteractionAt !== undefined) {
      sets.push(`last_interaction_at = $${i++}`);
      vals.push(patch.lastInteractionAt);
    }
    if (patch.mode !== undefined) {
      sets.push(`mode = $${i++}`);
      vals.push(patch.mode);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this.pool.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  }

  async endSession(id: string, reason: SessionEndReason): Promise<void> {
    // WHERE ended_at IS NULL makes this idempotent — a re-end keeps the first reason/time.
    await this.pool.query(
      `UPDATE sessions SET ended_at = $1, end_reason = $2 WHERE id = $3 AND ended_at IS NULL`,
      [nowSec(), reason, id],
    );
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async appendMessages(sessionId: string, messages: NewMessage[]): Promise<TranscriptMessage[]> {
    if (messages.length === 0) return [];
    return this.withTx(async (client) => {
      const out: TranscriptMessage[] = [];
      for (const m of messages) {
        const createdAt = m.createdAt ?? nowSec();
        const res = await client.query(
          `INSERT INTO messages (session_id, role, content, created_at)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [sessionId, m.role, JSON.stringify(m.payload), createdAt],
        );
        const id = Number(res.rows[0].id);
        out.push({
          id,
          sessionId,
          role: m.role,
          payload: m.payload,
          isSummary: false,
          compactedStartId: null,
          compactedById: null,
          createdAt,
        });
      }
      return out;
    });
  }

  async getMessages(sessionId: string, opts: GetMessagesOptions = {}): Promise<TranscriptMessage[]> {
    let sql = `SELECT * FROM messages WHERE session_id = $1`;
    const vals: unknown[] = [sessionId];
    let i = 2;
    if (!opts.includeInactive) sql += ` AND compacted_by_id IS NULL`;
    if (!opts.includeSummaries) sql += ` AND is_summary = 0`;
    sql += ` ORDER BY id`; // conversation order — never timestamp
    if (opts.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      vals.push(opts.limit);
    }
    if (opts.offset !== undefined) {
      // Postgres allows OFFSET without LIMIT — no workaround needed.
      sql += ` OFFSET $${i++}`;
      vals.push(opts.offset);
    }
    const res = await this.pool.query(sql, vals);
    return (res.rows as MessageRow[]).map(toMessage);
  }

  async getLiveSummary(sessionId: string): Promise<TranscriptMessage | null> {
    // At most one row can match; ORDER BY id guards against a bug upstream ever
    // leaving two, by picking the newest rather than an arbitrary one.
    const res = await this.pool.query(
      `SELECT * FROM messages
        WHERE session_id = $1 AND compacted_by_id IS NULL AND is_summary = 1
        ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    const row = (res.rows as MessageRow[])[0];
    return row ? toMessage(row) : null;
  }

  async compact(
    sessionId: string,
    summary: NewMessage,
    boundary: CompactionBoundary,
  ): Promise<CompactionResult> {
    return this.withTx(async (client) => {
      const createdAt = summary.createdAt ?? nowSec();
      const ins = await client.query(
        `INSERT INTO messages (session_id, role, content, is_summary, compacted_start_id, created_at)
         VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`,
        [sessionId, summary.role, JSON.stringify(summary.payload), boundary.startId, createdAt],
      );
      const id = Number(ins.rows[0].id);

      // Archive the span. Bounds are inclusive — both name rows being destroyed, so
      // the retained head and first tail row sit outside them. Concurrent appends
      // take ids above endId and are left alone; the summary just inserted is above
      // it too, so it can't archive itself.
      const span = await client.query(
        `UPDATE messages SET compacted_by_id = $1
         WHERE session_id = $2 AND compacted_by_id IS NULL AND is_summary = 0
           AND id >= $3 AND id <= $4`,
        [id, sessionId, boundary.startId, boundary.endId],
      );
      const spanCount = span.rowCount ?? 0;

      // A stale boundary would leave a summary describing nothing. Checked on the
      // span alone — folding in the previous summary isn't compaction progress.
      // Throwing rolls the insert back with it.
      if (spanCount === 0) {
        throw new Error(
          `compact: no live rows in [${boundary.startId}, ${boundary.endId}] ` +
            `for session ${sessionId}`,
        );
      }

      // The previous summary sits outside the span whenever its id landed above
      // endId, so it needs archiving by identity, not by range. `id <> $1`
      // spares the one just inserted.
      const prev = await client.query(
        `UPDATE messages SET compacted_by_id = $1
         WHERE session_id = $2 AND compacted_by_id IS NULL AND is_summary = 1 AND id <> $1`,
        [id, sessionId],
      );

      return {
        archivedCount: spanCount + (prev.rowCount ?? 0),
        summary: {
          id,
          sessionId,
          role: summary.role,
          payload: summary.payload,
          isSummary: true,
          compactedStartId: boundary.startId,
          compactedById: null,
          createdAt,
        },
      };
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Convenience factory: open the pool, migrate, and return a ready store for MODE=CLOUD. */
export async function createPostgresSessionStore(connection: string): Promise<SessionStore> {
  const store = new PostgresSessionStore(connection);
  await store.migrate();
  return store;
}
