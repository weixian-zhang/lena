import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A local stdio Azure MCP server (`@azure/mcp`), one cached instance per namespace,
// shared across calls. Each server is scoped to a single namespace with `--mode all`
// (every command is its own tool rather than hidden behind a router tool); we then
// resolve the one tool we actually call. Generic on purpose: the azure-cli and pricing
// tools both build their session from createMcpSession(), differing only in which
// namespace to start and which tool to resolve.

/** `npx` fetches `@azure/mcp` on first run. */
const SERVER_COMMAND = "npx";

/** Startup + handshake budget; generous because the first `npx` run downloads. */
const STARTUP_TIMEOUT_MS = 120_000;

/** How to pick the single tool we call from a server's advertised tool list. */
export type ToolSelector = { name: string } | { filter: string };

export interface McpServerConfig {
  /** Azure MCP namespace to scope the server to (e.g. "extension", "pricing"). */
  namespace: string;
  /** Which advertised tool to route calls to: an exact name, or a unique substring. */
  tool: ToolSelector;
}

export interface McpSession {
  /** Connected MCP client, ready for `callTool`. */
  client: Client;
  /** Resolved name of the tool to route calls to. */
  toolName: string;
}

function serverArgs(namespace: string): string[] {
  return ["-y", "@azure/mcp@latest", "server", "start", "--namespace", namespace, "--mode", "all"];
}

/** Our full environment as a `Record<string, string>`, dropping unset keys. */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
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

/** Resolve the tool to call: exact name, or a filter that must match exactly one tool. */
async function resolveTool(client: Client, selector: ToolSelector): Promise<string> {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const seen = names.join(", ") || "(none)";

  if ("name" in selector) {
    if (names.includes(selector.name)) return selector.name;
    throw new Error(`Azure MCP server exposed no "${selector.name}" tool. Saw: ${seen}`);
  }

  const filter = selector.filter.toLowerCase();
  const matches = names.filter((n) => n.toLowerCase().includes(filter));
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  throw new Error(
    `Azure MCP tool filter "${selector.filter}" matched ${matches.length} tools ` +
      `(expected exactly one). Saw: ${seen}`,
  );
}

async function createSession(config: McpServerConfig): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: SERVER_COMMAND,
    args: serverArgs(config.namespace),
    // Forward our env so the server's DefaultAzureCredential finds the SP creds
    // (AZURE_CLIENT_ID/SECRET/TENANT_ID) — the transport otherwise inherits only a
    // safe subset (HOME/PATH/...) and the credential chain stalls without them.
    // AZURE_TOKEN_CREDENTIALS=client pins the chain to the SP (client-secret) path
    // so it doesn't wander to CLI/managed-identity creds and stall.
    env: { ...inheritedEnv(), AZURE_TOKEN_CREDENTIALS: "prod" }, //"AzureCliCredential"}, //client" },
    stderr: "pipe", // keep the child's logs off our stdio
  });

  const client = new Client({ name: "lena", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: STARTUP_TIMEOUT_MS });

  const toolName = await resolveTool(client, config.tool);
  return { client, toolName };
}

/**
 * Build a cached session getter for one Azure MCP namespace/tool. Concurrent callers
 * share one spawn; a failed startup clears the cache so a dead child process doesn't
 * poison later calls.
 */
export function createMcpSession(config: McpServerConfig): () => Promise<McpSession> {
  let session: Promise<McpSession> | undefined;
  return () => {
    if (!session) {
      session = createSession(config).catch((err) => {
        session = undefined;
        throw err;
      });
    }
    return session;
  };
}
