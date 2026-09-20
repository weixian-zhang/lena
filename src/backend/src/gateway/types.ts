/**
 * Gateway-owned domain types: the normalized contract between channel adapters
 * (Slack / Teams / CLI) and the session module.
 *
 * A channel adapter produces an {@link InboundMessage}; the session module
 * consumes it — as the sole input to the deterministic session-key builder and
 * persisted as JSON on `sessions.source`. The model never picks a channel or key.
 */

/** How much of the (channel, chat, user) identity a session isolates on. */
export type ChatType = "dm" | "group" | "cli" | "cron";

/** Normalized inbound descriptor produced by each channel adapter. */
export type InboundMessage = {
  /** Origin channel: `slack` | `teams` | `cli` | … */
  channel: string;
  /** Target agent. Currently always `lena`; a real key segment for future multi-agent. */
  agentId: string;
  chatType: ChatType;
  /** Conversation container id (DM id, channel id, group id). */
  chatId?: string;
  /** Sender id as seen on the wire. */
  userId?: string;
};
