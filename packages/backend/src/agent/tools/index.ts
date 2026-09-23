import type { AgentTool } from "@mariozechner/pi-agent-core";
// azure_cli_generate is disabled for now: its backing MCP endpoint only accepts a
// user/delegated token (401s on the service-principal/app token a hosted Lena uses),
// and the model is capable enough at emitting `az` syntax on its own. Re-enable by
// restoring this import and the registry entry below.
// import { azureCliGenerateTool } from "./azure-mcp/azure-cli.js";
import { azurePricingTool } from "./azure-mcp/pricing.js";
import { bashTool } from "./bash.js";
import { clarifyTool } from "./clarify.js";
import { proposePlanTool } from "./propose-plan.js";

/**
 * Tool registry — the Azure surface Lena acts through.
 *
 * Each capability (resource graph, cost, deploy, KQL, bash, ...) becomes one tool here.
 * Contract (see CLAUDE.md): tools throw on failure, never return error strings as content,
 * and expose NO delete/remove capability — deletion is gated out by design.
 *
 * `bash` is the single execution surface: a shell with the Azure CLI pre-authenticated,
 * plus every other binary on the host (node, python, jq, git).
 * `propose_plan` is the Investigate→Action gate: it presents a plan and ends the run,
 * so mutations only follow an approval. It executes nothing itself.
 * `clarify` asks the user a question (optional pickable choices) and ends the run, so the
 * model resolves genuine ambiguity instead of guessing. Both are terminate-and-resume: the
 * user's next message is the answer.
 * `azure_pricing` looks up Azure retail pricing (via the MCP server, `pricing`
 * namespace) for cost estimation. Narrower typed tools (e.g. Resource Graph) land
 * alongside them as needs arise.
 */
export const tools: AgentTool[] = [
  bashTool,
  proposePlanTool,
  clarifyTool,
  // azureCliGenerateTool, // disabled — see import note above
  azurePricingTool,
];
