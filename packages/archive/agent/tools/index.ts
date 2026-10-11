import type { AgentTool } from "@mariozechner/pi-agent-core";
// azure_cli_generate is disabled for now: its backing MCP endpoint only accepts a
// user/delegated token (401s on the service-principal/app token a hosted Lena uses),
// and the model is capable enough at emitting `az` syntax on its own. Re-enable by
// restoring this import and the registry entry below.
// import { azureCliGenerateTool } from "./azure-mcp/azure-cli.js";
import { bashTool } from "./bash.js";

/**
 * Tool registry — the Azure surface Lena acts through.
 *
 * Each capability (resource graph, cost, deploy, KQL, bash, ...) becomes one tool here.
 * Contract (see CLAUDE.md): tools throw on failure, never return error strings as content,
 * and expose NO delete/remove capability — deletion is gated out by design.
 *
 * `bash` is the single execution surface: a shell with the Azure CLI pre-authenticated,
 * plus every other binary on the host (node, python, jq, git).
 */
export const tools: AgentTool[] = [
  bashTool,
  // azureCliGenerateTool, // disabled — see import note above
];
