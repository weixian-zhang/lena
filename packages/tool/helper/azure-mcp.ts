import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A local stdio Azure MCP server (`@azure/mcp`) scoped to one namespace with
// `--mode all`, so each command is its own tool rather than hidden behind a router.

/** Startup + handshake budget; generous because the first `npx` run downloads. */
const STARTUP_TIMEOUT_MS = 120_000;

export type McpServerConfig = {
  /** Azure MCP namespace to scope the server to (e.g. "extension"). */
  namespace: string;
  /** The advertised tool calls are routed to; startup fails if the server lacks it. */
  toolName: string;
};

/**
 * Build a cached getter for a connected client of one Azure MCP namespace. Concurrent
 * callers share one spawn; a failed startup clears the cache so a dead child process
 * doesn't poison later calls.
 */
export function createMcpSession(config: McpServerConfig): () => Promise<Client> {
  let client: Promise<Client> | undefined;
  return () =>
    (client ??= connectToServer(config).catch((error: unknown) => {
      client = undefined;
      throw error;
    }));
}

/** Join the text parts of an MCP tool result into one string. */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function connectToServer({ namespace, toolName }: McpServerConfig): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@azure/mcp@latest", "server", "start", "--namespace", namespace, "--mode", "all"],
    // The transport otherwise inherits only HOME/PATH/…; the server's credential chain
    // needs the SP env vars, and `prod` keeps it off developer CLI creds that stall.
    env: { ...definedProcessEnv(), AZURE_TOKEN_CREDENTIALS: "prod" },
    stderr: "pipe", // keep the child's logs off our stdio
  });

  const client = new Client({ name: "lena", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: STARTUP_TIMEOUT_MS });

  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === toolName)) {
    const seen = tools.map((tool) => tool.name).join(", ") || "(none)";
    throw new Error(`Azure MCP server exposed no "${toolName}" tool. Saw: ${seen}`);
  }
  return client;
}

/** `process.env` without its unset keys, as the transport's `Record<string, string>`. */
function definedProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
