import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { getAzureSession, MAX_OUTPUT_BYTES, runShell } from "../cloud-shell.js";

const schema = Type.Object({
  command: Type.String({
    description: "The bash command to run. Use `-o json` for `az` output you need to parse.",
  }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds. Omit for no timeout." }),
  ),
});

export type BashToolInput = Static<typeof schema>;

/**
 * Fast-fail deny-list for obviously destructive commands.
 *
 * IMPORTANT: this is a UX + audit speed bump, NOT the security boundary. A bash
 * string cannot be reliably parsed for intent (`eval`, `$(...)`, base64, aliases,
 * `az rest --method delete`, `curl -X DELETE https://management.azure.com/...`).
 * The load-bearing no-delete guarantee is the service principal's Azure RBAC role
 * whose NotActions exclude every delete action — the platform returns 403 regardless
 * of how the command is phrased. This regex just catches the common cases early with
 * a clear message and gives us something to log.
 */
const DELETION_PATTERN =
  /\b(rm\s+-[a-z]*[rf]|rmdir|az\b[^|;&]*\bdelete\b|--method[= ]+delete|-X[= ]*delete|\bpurge\b)/i;

/**
 * Coarse heuristic: does this command likely change Azure state? Used only to decide
 * when to invalidate the cached topography (the agent's afterToolCall hook) — NOT a
 * security control and not exhaustive. Read-only `az ... list/show` stays cached;
 * create/update/etc. bust the cache so the next turn re-reads. Over-matching merely
 * costs a re-query; the topography TTL is the backstop for anything it misses.
 */
const MUTATION_PATTERN =
  /\baz\b[^|;&]*\b(create|update|set|add|deploy|start|stop|restart|scale|deallocate|reset|attach|detach|enable|disable|import|move)\b/i;

export function isMutatingCommand(command: string): boolean {
  return MUTATION_PATTERN.test(command);
}

/**
 * Lena's primary execution surface: run a bash command with the Azure CLI
 * pre-authenticated (see {@link getAzureSession}). One tool rather than separate
 * `az` / `node` tools — both are just binaries in this same shell, and a single
 * choke point means the delete gate and (future) HITL confirmation live in
 * exactly one place. See CLAUDE.md ("Tools = the Azure surface").
 *
 * TODO(HITL): mutating commands (create/update/stop/restart/scale/deallocate)
 * should pause for human confirmation. That requires the interaction channel
 * from the not-yet-built gateway; wire it here once that lands.
 */
export const bashTool: AgentTool<typeof schema> = {
  name: "bash",
  label: "bash",
  description:
    "Run a bash command. Use this for Azure CLI (`az` is pre-authenticated against the target " +
    "subscription) and for any other shell tool (jq, grep, curl, git, node). " +
    "To run JavaScript, write a `.mjs` file with a quoted heredoc (`cat > x.mjs <<'EOF'`) and " +
    "run `node x.mjs` — that keeps the shell from touching the source, and gives real line " +
    "numbers in stack traces. Deleting Azure resources is out of scope and blocked.",
  parameters: schema,
  async execute(_toolCallId, { command, timeout }, signal) {
    if (DELETION_PATTERN.test(command)) {
      throw new Error(
        "Deletion is out of scope by design and is blocked. If the user needs a resource " +
          "deleted, explain how they can do it themselves or escalate — do not attempt it.",
      );
    }

    const { env, cwd } = await getAzureSession();
    const { stdout, exitCode, truncated } = await runShell(command, { cwd, env, signal, timeout });

    const suffix = truncated
      ? `\n\n[output truncated at ${MAX_OUTPUT_BYTES / 1000} KB — narrow the query with --query, -o tsv, or a filter]`
      : "";
    const text = (stdout || "(no output)") + suffix;

    // Contract (CLAUDE.md + pi AgentTool): throw on failure, never return an error
    // string as normal content. `null` means killed by signal — handled as abort/timeout.
    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(text);
    }

    return { content: [{ type: "text", text }], details: undefined };
  },
};
