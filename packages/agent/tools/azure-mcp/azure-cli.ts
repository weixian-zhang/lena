import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { createMcpSession, extractText } from "./mcp-server.js";

/** Milliseconds to allow a single generate call before giving up. */
const CALL_TIMEOUT_MS = 60_000;

// Azure CLI-generate via the Azure MCP server's `extension` namespace. Reuses the
// shared MCP session helper, scoped to its own namespace so its tool list stays small.
const getCliGenerateSession = createMcpSession({
  namespace: "extension",
  tool: { name: "extension_cli_generate" },
});

const schema = Type.Object({
  intent: Type.String({
    description:
      "Natural-language description of the Azure goal to accomplish, e.g. " +
      "\"create a storage account with GRS redundancy in resource group rg-data\" or " +
      "\"list all VMs in a resource group that are running\". The tool returns the exact " +
      "`az` command(s) to accomplish it — it does not run them.",
  }),
});

export type AzureCliGenerateInput = Static<typeof schema>;

// Generate an `az` command from a natural-language intent via Azure's MCP
// server. Returns command text only — no side effects; run it with `bash`.
// `cli-type` is pinned to `az` since that's the only CLI Lena executes.
export const azureCliGenerateTool: AgentTool<typeof schema> = {
  name: "azure_cli_generate",
  label: "azure cli generate",
  description:
    "Generate the exact Azure CLI (`az`) command for a described goal, using Azure's own " +
    "up-to-date CLI knowledge. Returns command TEXT only — it does not execute anything, so " +
    "run the result with the `bash` tool. Use it when unsure of exact `az` syntax, flags, or " +
    "the newest command shape.",
  parameters: schema,
  async execute(_toolCallId, { intent }, signal) {
    const { client, toolName } = await getCliGenerateSession();

    const result = await client.callTool(
      { name: toolName, arguments: { intent, "cli-type": "az" } },
      undefined,
      { signal, timeout: CALL_TIMEOUT_MS },
    );

    const text = extractText(result.content);

    // Throw on failure, never return an error string as content (see CLAUDE.md).
    if (result.isError) {
      throw new Error(text || "azure_cli_generate failed without an error message.");
    }

    return {
      content: [{ type: "text", text: text || "(no command generated)" }],
      details: undefined,
    };
  },
};
