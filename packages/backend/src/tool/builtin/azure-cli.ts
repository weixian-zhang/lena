import { Type } from "typebox";
import type { Tool } from "../types.js";
import { createMcpSession, extractText } from "./azure-mcp.js";

/** Milliseconds to allow a single generate call before giving up. */
const CALL_TIMEOUT_MS = 60_000;

/** The Azure MCP `extension` namespace tool that writes `az` commands. */
const CLI_GENERATE_TOOL_NAME = "extension_cli_generate";

const azcliMcpClient = createMcpSession({ namespace: "extension", toolName: CLI_GENERATE_TOOL_NAME });

const schema = Type.Object({
  intent: Type.String({
    description:
      "Natural-language description of the Azure goal to accomplish, e.g. " +
      "\"create a storage account with GRS redundancy in resource group rg-data\" or " +
      "\"list all VMs in a resource group that are running\". The tool returns the exact " +
      "`az` command(s) to accomplish it — it does not run them.",
  }),
});

/**
 * Generate an `az` command from a natural-language intent via Azure's MCP server.
 * Returns command text only — no side effects; run it with `bash`. `cli-type` is
 * pinned to `az` since that's the only CLI Lena executes.
 */
export const azureCliGenerateTool: Tool<typeof schema> = {
  name: "azure_cli_generate",
  description:
    "Generate the exact Azure CLI (`az`) command for a described goal, using Azure's own " +
    "up-to-date CLI knowledge. Returns command TEXT only — it does not execute anything, so " +
    "run the result with the `bash` tool. Use it when unsure of exact `az` syntax, flags, or " +
    "the newest command shape.",
  parameters: schema,
  async execute({ intent }, abortSignal) {
    const client = await azcliMcpClient();

    const result = await client.callTool(
      { name: CLI_GENERATE_TOOL_NAME, arguments: { intent, "cli-type": "az" } },
      undefined,
      { signal: abortSignal, timeout: CALL_TIMEOUT_MS },
    );

    const text = extractText(result.content);
    if (result.isError) throw new Error(text || "azure_cli_generate failed without an error message.");
    return text || "(no command generated)";
  },
};
