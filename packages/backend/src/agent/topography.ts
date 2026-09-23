import { type AzureSession, getAzureSession, runShell } from "./cloud-shell.js";

// ---------------------------------------------------------------------------
// Topography — a read-only snapshot of the Azure environment Lena can see.
//
// Purpose: grounding data for the LLM. When a user says "provision a VM" without
// naming a subscription / resource group / vnet, the model should ground its plan
// in what actually exists here rather than inventing names. This module pulls the
// structural skeleton — subscriptions, resource groups, vnets + subnets — via Azure
// Resource Graph (`az graph`), reusing the one cached login from cloud-shell.
//
// Read-only by construction: Resource Graph cannot mutate anything, and the SP's
// RBAC (Reader on the visible scopes) is the real boundary. See CLAUDE.md.
// ---------------------------------------------------------------------------

export type Subscription = {
  subscriptionId: string;
  name: string;
  tenantId?: string;
  /** e.g. "Enabled", "Disabled", "Warned". */
  state?: string;
}

export type ResourceGroup = {
  subscriptionId: string;
  name: string;
  location: string;
}

export type Subnet = {
  name: string;
  /** CIDR(s). Newer vnets use `addressPrefixes` (plural); older ones `addressPrefix`. */
  addressPrefixes: string[];
}

export type VNet = {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
  location: string;
  addressPrefixes: string[];
  subnets: Subnet[];
}

export type Topography = {
  subscriptions: Subscription[];
  resourceGroups: ResourceGroup[];
  vnets: VNet[];
  /** True if any query hit the page cap or a page overflowed the output limit — data may be partial. */
  truncated: boolean;
}

// Resource Graph tables:
//   ResourceContainers → subscriptions + resource groups
//   Resources          → everything else (vnets here)
// We project the few columns we need so a large tenant stays under the output cap.

const SUBSCRIPTIONS_QUERY = `
ResourceContainers
| where type =~ 'microsoft.resources/subscriptions'
| project subscriptionId, name, tenantId, state = tostring(properties.state)
| order by name asc`;

const RESOURCE_GROUPS_QUERY = `
ResourceContainers
| where type =~ 'microsoft.resources/subscriptions/resourcegroups'
| project subscriptionId, name, location
| order by subscriptionId asc, name asc`;

// mv-expand fans out one row per subnet; we reassemble by vnet in TS. Trade-off:
// a vnet with zero subnets is dropped (mv-expand yields no rows for an empty array).
// Acceptable for grounding — an empty vnet can't host a resource anyway.
const VNETS_QUERY = `
Resources
| where type =~ 'microsoft.network/virtualnetworks'
| mv-expand subnet = properties.subnets
| project subscriptionId,
          resourceGroup,
          vnetName = name,
          location,
          vnetAddressPrefixes = properties.addressSpace.addressPrefixes,
          subnetName = tostring(subnet.name),
          subnetAddressPrefixes = coalesce(subnet.properties.addressPrefixes, pack_array(tostring(subnet.properties.addressPrefix)))
| order by subscriptionId asc, resourceGroup asc, vnetName asc`;

type VNetSubnetRow = {
  subscriptionId: string;
  resourceGroup: string;
  vnetName: string;
  location: string;
  vnetAddressPrefixes: string[] | null;
  subnetName: string;
  subnetAddressPrefixes: string[] | null;
}

// Page size kept well under MAX_OUTPUT_BYTES: a full page of projected rows must
// fit so JSON.parse never sees a truncated document. Paging follows the skip token.
const GRAPH_PAGE_SIZE = 300;
const MAX_GRAPH_PAGES = 50;

/** POSIX single-quote a string for safe embedding in a `/bin/bash -c` command. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type GraphResponse<T> = {
  data: T[];
  skipToken?: string;
}

/** `az graph query -o json` returns `{ data, skip_token, ... }`; older builds return a bare array. */
function parseGraphResponse<T>(stdout: string): GraphResponse<T> {
  const json = JSON.parse(stdout);
  if (Array.isArray(json)) return { data: json };
  const data = Array.isArray(json?.data) ? json.data : [];
  const skipToken = json?.skip_token ?? json?.skipToken;
  return { data, skipToken: skipToken || undefined };
}

/**
 * Run one Resource Graph query, following the skip token until every page is drained
 * or the page cap is hit. `truncated` flags a partial result (a page overflowed the
 * output cap, or there were more pages than {@link MAX_GRAPH_PAGES}).
 */
async function runGraphQuery<T>(
  query: string,
  session: AzureSession,
  signal?: AbortSignal,
): Promise<{ rows: T[]; truncated: boolean }> {
  // Dynamic-install lets `az graph` self-provision the resource-graph extension on a
  // bare SP host (Cloud Shell has it preinstalled) without an interactive prompt.
  const env: NodeJS.ProcessEnv = {
    ...session.env,
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "yes_without_prompt",
  };

  const rows: T[] = [];
  let skipToken: string | undefined;

  for (let page = 0; page < MAX_GRAPH_PAGES; page++) {
    const skipArg = skipToken ? ` --skip-token ${shQuote(skipToken)}` : "";
    const command =
      `az graph query -q ${shQuote(query)} --first ${GRAPH_PAGE_SIZE}${skipArg} ` +
      `-o json --only-show-errors`;

    const result = await runShell(command, { cwd: session.cwd, env, signal });
    if (result.exitCode !== 0) {
      throw new Error(`az graph query failed:\n${result.stdout || "(no output)"}`);
    }
    // A truncated page is invalid JSON — stop with what we have and flag it.
    if (result.truncated) return { rows, truncated: true };

    const { data, skipToken: next } = parseGraphResponse<T>(result.stdout);
    rows.push(...data);
    skipToken = next;
    if (!skipToken) return { rows, truncated: false };
  }
  // Ran out of page budget with a skip token still pending.
  return { rows, truncated: true };
}

function assembleVNets(rows: VNetSubnetRow[]): VNet[] {
  const byKey = new Map<string, VNet>();
  for (const row of rows) {
    const key = `${row.subscriptionId}/${row.resourceGroup}/${row.vnetName}`;
    let vnet = byKey.get(key);
    if (!vnet) {
      vnet = {
        subscriptionId: row.subscriptionId,
        resourceGroup: row.resourceGroup,
        name: row.vnetName,
        location: row.location,
        addressPrefixes: row.vnetAddressPrefixes ?? [],
        subnets: [],
      };
      byKey.set(key, vnet);
    }
    if (row.subnetName) {
      vnet.subnets.push({
        name: row.subnetName,
        addressPrefixes: (row.subnetAddressPrefixes ?? []).filter(Boolean),
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Retrieve the Azure environment skeleton — subscriptions, resource groups, and
 * vnets/subnets — via Resource Graph. Queries run sequentially so the first call
 * warms the resource-graph extension install before the rest, avoiding an install race.
 */
export async function getTopography(options: { signal?: AbortSignal } = {}): Promise<Topography> {
  const session = await getAzureSession();
  const { signal } = options;

  const subscriptions = await runGraphQuery<Subscription>(SUBSCRIPTIONS_QUERY, session, signal);
  const resourceGroups = await runGraphQuery<ResourceGroup>(RESOURCE_GROUPS_QUERY, session, signal);
  const vnetRows = await runGraphQuery<VNetSubnetRow>(VNETS_QUERY, session, signal);

  return {
    subscriptions: subscriptions.rows,
    resourceGroups: resourceGroups.rows,
    vnets: assembleVNets(vnetRows.rows),
    truncated: subscriptions.truncated || resourceGroups.truncated || vnetRows.truncated,
  };
}

// ---------------------------------------------------------------------------
// Cache — one in-memory snapshot shared across turns.
//
// getTopography() always hits Azure; getCachedTopography() serves a snapshot for up
// to CACHE_TTL_MS and is what the per-turn grounding injection calls, so a busy
// investigate/action loop doesn't re-query every turn. invalidateTopography() drops
// it after Lena mutates the environment (the agent's afterToolCall hook), so the next
// turn re-reads and reflects the change immediately; the TTL is the backstop for
// external drift the mutation hook can't see.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; value: Promise<Topography> } | undefined;

export function getCachedTopography(options: { signal?: AbortSignal } = {}): Promise<Topography> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const value = getTopography(options);
  cache = { at: now, value };
  // Never cache a failure: if the fetch rejects, drop the entry so the next call retries.
  value.catch(() => {
    if (cache?.value === value) cache = undefined;
  });
  return value;
}

export function invalidateTopography(): void {
  cache = undefined;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const arr = map.get(key(item));
    if (arr) arr.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}

/**
 * Render a topography as compact markdown for the model's grounding context: what
 * subscriptions / resource groups / vnets exist, so the model picks a real target
 * instead of guessing. Kept terse — this rides in the context window.
 */
export function formatTopography(topo: Topography): string {
  if (topo.subscriptions.length === 0) {
    return "No Azure subscriptions are visible to Lena — the service principal likely has no role assignment on any subscription yet.";
  }

  const rgsBySub = groupBy(topo.resourceGroups, (r) => r.subscriptionId);
  const vnetsBySub = groupBy(topo.vnets, (v) => v.subscriptionId);

  const lines: string[] = ["# Azure resource snapshot"];
  if (topo.truncated) {
    lines.push("_Note: results were truncated — the topography below may be incomplete._");
  }

  for (const sub of topo.subscriptions) {
    const state = sub.state ? ` [${sub.state}]` : "";
    lines.push("", `## ${sub.name} — \`${sub.subscriptionId}\`${state}`);

    const rgs = rgsBySub.get(sub.subscriptionId) ?? [];
    lines.push(
    rgs.length
        ? `Resource groups (${rgs.length}): ${rgs.map((r) => `${r.name} (${r.location})`).join(", ")}`
        : "Resource groups: none",
    );

    const vnets = vnetsBySub.get(sub.subscriptionId) ?? [];
    if (vnets.length === 0) {
      lines.push("VNets: none");
      continue;
    }
    lines.push("VNets:");
    for (const v of vnets) {
      const space = v.addressPrefixes.length ? ` ${v.addressPrefixes.join(", ")}` : "";
      const subnets = v.subnets.length
        ? v.subnets.map((s) => `${s.name} ${s.addressPrefixes.join(",") || "?"}`).join("; ")
        : "no subnets";
      lines.push(`- ${v.name} (${v.resourceGroup}, ${v.location})${space} — subnets: ${subnets}`);
    }
  }

  return lines.join("\n");
}
