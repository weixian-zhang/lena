import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { createMcpSession, extractText } from "./mcp-server.js";

/** Milliseconds to allow a single pricing call before giving up. */
const CALL_TIMEOUT_MS = 60_000;

// Azure retail pricing via the Azure MCP server's `pricing` namespace (tool
// `pricing_get`). Reuses the shared MCP session helper, scoped to its own namespace
// so its tool list stays small. Read-only — it queries the public retail rate card,
// never account-specific spend.
const getPricingSession = createMcpSession({
  namespace: "pricing",
  tool: { filter: "pricing" },
});

const schema = Type.Object({
  sku: Type.Optional(
    Type.String({ description: "ARM SKU name, e.g. Standard_D4s_v5 or Standard_E64-16ds_v4." }),
  ),
  service: Type.Optional(
    Type.String({
      description: 'Azure service name, e.g. "Virtual Machines", "Storage", "SQL Database".',
    }),
  ),
  region: Type.Optional(
    Type.String({ description: "Azure region, e.g. eastus, westeurope, westus2." }),
  ),
  serviceFamily: Type.Optional(
    Type.String({ description: "Service family, e.g. Compute, Storage, Databases, Networking." }),
  ),
  priceType: Type.Optional(
    Type.String({ description: "Price type: Consumption, Reservation, or DevTestConsumption." }),
  ),
  currency: Type.Optional(
    Type.String({ description: "ISO currency code for the prices (e.g. USD, EUR). Defaults to USD." }),
  ),
  includeSavingsPlan: Type.Optional(
    Type.Boolean({
      description: "Include 1-year/3-year savings-plan pricing (mainly Linux VMs). Uses a preview API.",
    }),
  ),
  filter: Type.Optional(
    Type.String({
      description: "Raw OData filter for advanced queries, e.g. \"meterId eq 'abc-123'\". Rarely needed.",
    }),
  ),
});

export type AzurePricingInput = Static<typeof schema>;

/** MCP option keys are kebab-case; map our camelCase inputs onto them, dropping unset ones. */
function toMcpArguments(input: AzurePricingInput): Record<string, string> {
  const args: Record<string, string> = {};
  if (input.sku) args.sku = input.sku;
  if (input.service) args.service = input.service;
  if (input.region) args.region = input.region;
  if (input.serviceFamily) args["service-family"] = input.serviceFamily;
  if (input.priceType) args["price-type"] = input.priceType;
  if (input.currency) args.currency = input.currency;
  if (input.includeSavingsPlan !== undefined) {
    args["include-savings-plan"] = String(input.includeSavingsPlan);
  }
  if (input.filter) args.filter = input.filter;
  return args;
}

/** The MCP tool requires at least one of these to bound the query. */
function hasScopingFilter(input: AzurePricingInput): boolean {
  return Boolean(input.sku || input.service || input.region || input.serviceFamily || input.filter);
}

export const azurePricingTool: AgentTool<typeof schema> = {
  name: "azure_pricing",
  label: "azure pricing",
  description:
    "Look up Azure retail (pay-as-you-go) pricing from Azure's public rate card — for cost " +
    "estimation and SKU/region comparisons. Read-only; returns rates, not a bill. Requires at " +
    "least one of `sku`, `service`, `region`, `serviceFamily`, or `filter` — for an accurate " +
    "number ask the user for the exact SKU/tier rather than guessing. Prefer `sku` (+ `region`) " +
    "for a specific rate. For a monthly estimate, multiply an hourly Consumption price by 730.",
  parameters: schema,
  async execute(_toolCallId, input, signal) {
    if (!hasScopingFilter(input)) {
      throw new Error(
        "azure_pricing needs at least one of: sku, service, region, serviceFamily, or filter. " +
          "Ask the user for a specific SKU or service before querying.",
      );
    }

    const { client, toolName } = await getPricingSession();
    const result = await client.callTool(
      { name: toolName, arguments: toMcpArguments(input) },
      undefined,
      { signal, timeout: CALL_TIMEOUT_MS },
    );

    const text = extractText(result.content);
    // Throw on failure, never return an error string as content (see CLAUDE.md).
    if (result.isError) {
      throw new Error(text || "azure_pricing failed without an error message.");
    }

    return {
      content: [{ type: "text", text: text || "(no pricing data returned)" }],
      details: undefined,
    };
  },
};
