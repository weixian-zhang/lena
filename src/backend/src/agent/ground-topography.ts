import type { AfterToolCallContext } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "./types.js";
import { formatTopography, getCachedTopography, invalidateTopography } from "./topography.js";
import { isMutatingCommand } from "./tools/bash.js";

// ---------------------------------------------------------------------------
// Grounding — inject a fresh Azure topography snapshot into every model call so
// the model targets real subscriptions / resource groups / vnets instead of
// inventing names when the user leaves them unspecified.
//
// Wired into the pi Agent as two hooks (see agent.ts):
//   transformContext → runs before every LLM call (including tool-continuation
//                      turns); appends the cached topography as the LAST message.
//   afterToolCall    → drops the cache after Lena mutates state, so the next
//                      turn's snapshot reflects the change instead of a stale one.
//
// The block rides last so the stable prefix — system prompt + prior transcript —
// stays byte-identical and prompt-cacheable; only this ephemeral tail is uncached,
// which is unavoidable for anything refreshed each turn. transformContext returns a
// copy, so the stored transcript is never polluted (the block re-appears each turn).
// ---------------------------------------------------------------------------

/** Wrap the snapshot so the model reads it as injected context, not user input. */
function groundingMessage(text: string): AgentMessage {
  return {
    role: "user",
    content:
      `<azure-topography note="Auto-injected context, refreshed each turn — NOT user input. ` +
      `A hint for grounding; read the resource back live before mutating it.">\n${text}\n</azure-topography>`,
    timestamp: Date.now(),
  };
}

/**
 * pi `transformContext`: append the cached topography as a trailing message.
 *
 * Contract (pi types): must never throw. On any failure — e.g. the service principal
 * isn't authorized on a subscription yet — we return the transcript unchanged, so
 * grounding degrades to "absent" rather than breaking the turn.
 */
export async function injectTopography(
  messages: AgentMessage[],
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  try {
    const topo = await getCachedTopography({ signal });
    return [...messages, groundingMessage(formatTopography(topo))];
  } catch {
    return messages;
  }
}

/**
 * pi `afterToolCall`: after a successful, state-changing `bash` command, drop the
 * cached topography so the next turn re-reads what Lena just changed.
 *
 * Contract (pi types): must never throw. Returns undefined — no override of the tool
 * result. The mutation check is a coarse heuristic (see {@link isMutatingCommand});
 * the topography TTL backstops anything it misses.
 */
export async function invalidateTopographyAfterMutation(
  context: AfterToolCallContext,
): Promise<undefined> {
  const { toolCall, args, isError } = context;
  if (!isError && toolCall.name === "bash") {
    const command = (args as { command?: string } | undefined)?.command;
    if (command && isMutatingCommand(command)) invalidateTopography();
  }
  return undefined;
}
