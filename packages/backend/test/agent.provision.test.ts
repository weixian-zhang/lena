import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { createPiAgent } from "../src/agent/agent.js";
import { isMutatingCommand } from "../src/agent/tools/bash.js";
import { tools } from "../src/agent/tools/index.js";

// Live flow test: drives the real Lena agent through a multi-resource provisioning
// request and asserts it follows the Action protocol — Investigate, then stop at a
// proposed plan, run NO mutating command before approval, and only execute the
// `az ... create` commands after the user approves.
//
// It deliberately does NOT clean up: Lena never deletes Azure resources (CLAUDE.md),
// and the test harness doesn't either — this asserts the provisioning *flow*, not a
// throwaway resource lifecycle. Run it locally with src/backend/.env populated; it
// hits the network and SKIPS (rather than fails) when the model endpoint is unset.

// agent.ts loads .env from a build-relative path; load the backend .env here too so
// the config + credentials resolve when the test runs from source.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // No .env — rely on the ambient environment (e.g. CI secrets).
}

const SYSTEM_PROMPT = readFileSync(
  new URL("../src/agent/prompt/system-prompt.md", import.meta.url),
  "utf8",
);

/** Same resolution order as loadConfig() in agent.ts — endpoint + deployment. */
function modelConfigured(): boolean {
  const endpoint =
    process.env.MICROSOFT_FOUNDRY_ENDPOINT ||
    process.env.AI_FOUNDRY_DEPLOYMENT_ENDPOINT;
  const deployment =
    process.env.MICROSOFT_FOUNDRY_DEPLOYMENT_NAME ||
    process.env.AI_FOUNDRY_DEPLOYMENT_NAME;
  return Boolean(endpoint && deployment);
}

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, any> };

/** Every tool-call block across the transcript, optionally filtered by tool name. */
function toolCalls(agent: Agent, name?: string): ToolCallBlock[] {
  const calls: ToolCallBlock[] = [];
  for (const message of agent.state.messages) {
    if (message?.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && (name === undefined || block.name === name)) {
        calls.push(block as ToolCallBlock);
      }
    }
  }
  return calls;
}

/** The `command` string of a bash tool call (empty when absent). */
function bashCommand(call: ToolCallBlock): string {
  return String(call.arguments?.command ?? "");
}

/**
 * Subscribe to pi-agent-core's lifecycle event stream and log the events worth
 * eyeballing during a live run (`vitest --reporter=verbose`): run + turn
 * boundaries, each turn's assistant message (text preview, stop reason, token
 * usage), before/after every tool call, and any model-stream or tool error.
 *
 * The high-frequency streaming deltas (`message_update`, `tool_execution_update`)
 * are intentionally skipped — they'd bury the signal. Returns the unsubscribe fn.
 */
function subscribeAgentEvent(agent: Agent): () => void {
  const clip = (value: unknown, max = 160): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const assistantText = (message: AssistantMessage): string => {
    const text = message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return clip(text || "(no text)", 140);
  };

  let turn = 0;
  return agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start": // a prompt/continuation run began
        console.log("[agent] ▶ run start");
        break;
      case "turn_start": // one model round-trip (assistant message + its tools)
        console.log(`[agent] ── turn ${++turn} ──`);
        break;
      case "turn_end": {
        // The per-turn assistant message: what it said, why it stopped, tokens used.
        const message = event.message;
        if (!("role" in message) || message.role !== "assistant") break;
        const toolNames = message.content
          .filter((c): c is ToolCall => c.type === "toolCall")
          .map((c) => c.name);
        console.log(
          `[agent] assistant stop=${message.stopReason} tools=[${toolNames.join(", ")}] ` +
            `tokens=${message.usage?.totalTokens ?? "?"} :: ${assistantText(message)}`,
        );
        if (message.stopReason === "error") {
          console.log(`[agent] ✗ model error: ${message.errorMessage ?? "(no message)"}`);
        }
        break;
      }
      case "tool_execution_start": // before a tool runs — name + brief args
        console.log(
          `[agent] → tool ${event.toolName}(${clip(
            event.toolName === "bash" ? event.args?.command : event.args,
          )})`,
        );
        break;
      case "tool_execution_end": {
        // After a tool runs — flag failures and dump what it returned. The result's
        // `content` is a `{ type: "text", text }[]` block array (see bashTool.execute);
        // join the text so the actual `az` output is visible during a live run.
        const content = event.result?.content;
        const resultText = Array.isArray(content)
          ? content.map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("")
          : clip(content, 2000);
        console.log(`[agent] ← tool ${event.toolName} ${event.isError ? "✗ error" : "ok"}`);
        console.log(resultText);
        break;
      }
      case "message_update":
        // Stream the assistant's text as it's generated, delta by delta. Written raw
        // (no prefix/newline) so the tokens reconstruct into flowing text. Other
        // sub-events (thinking deltas, tool-call deltas, start/end) are skipped.
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;
      case "agent_end": // run finished
        console.log(`[agent] ■ run end — ${event.messages.length} messages`);
        break;
      default: // message_start/end, tool_execution_update — too chatty to log
        break;
    }
  });
}

// Concrete request — region, SKUs, names, admin user all pinned so the agent has no
// genuine ambiguity to `clarify` and should go straight to a plan.
const PROVISION_REQUEST = [
  "Provision the following in Southeast Asia (SEA). Use sensible defaults, don't ask me",
  "to clarify — give me ONE plan to approve:",
  "1. a resource group rg_by_lena_1 (SEA) with a tag `owner:lena`",
  '2. a virtual network vnet-by-lena-1 (10.0.0.0/16) with a subnet named "VM" (10.0.1.0/24)',
  '3. a Standard_B1s Ubuntu VM vm-by-lena-1, admin user azureuser, in the "VM" subnet',
  "4. a Standard_LRS storage account stbylena1",
  "5. tag all these new resources with `owner:lena`",
  "All inside rg_by_lena_1.",
].join("\n");

// Names/SKUs the presented plan must cover — proves it planned all four resources.
// Substring match survives collision-safe renames: if the names already exist, the
// agent proposes e.g. `rg_by_lena_1_sea` / `stbylena1sea`, which still contain these.
const PLAN_MUST_MENTION = [
  "rg_by_lena_1", // resource group
  "vnet-by-lena-1", // virtual network
  "vm-by-lena-1", // virtual machine
  "stbylena1", // storage account
  "b1s", // VM size (matches "B1s" or "Standard_B1s")
];

// Skips when the Foundry model isn't configured (e.g. CI without secrets), so a
// missing endpoint yields a skip rather than a failure.
test.skipIf(!modelConfigured())(
  "provisioning - multi-resource request follows the Action flow (plan → approve → execute)",
  // Generous: turn 1 runs several read-only investigation turns before the plan; the
  // model's turn count varies run to run.
  { timeout: 1200_000 },
  async () => {
    const agent = createPiAgent({ systemPrompt: SYSTEM_PROMPT, tools });

    // Event hook: log per-turn assistant messages, before/after each tool call,
    // and errors across the whole run. Detached at the end of the test.
    const detachEventLogger = subscribeAgentEvent(agent);

    // Turn 1: a state-changing request must stop at a proposed plan.
    await agent.prompt(PROVISION_REQUEST);
    await agent.waitForIdle();
    expect(
      agent.state.errorMessage,
      `agent turn errored: ${agent.state.errorMessage}`,
    ).toBeUndefined();

    const plans = toolCalls(agent, "propose_plan");
    expect(
      plans.length,
      "expected the provision to be gated behind propose_plan",
    ).toBeGreaterThan(0);

    // The gate: nothing that changes Azure state may run before approval.
    for (const call of toolCalls(agent, "bash")) {
      expect(
        isMutatingCommand(bashCommand(call)),
        `a mutating command ran before approval: ${bashCommand(call)}`,
      ).toBe(false);
    }

    // The plan must actually cover all four requested resources.
    const planText = JSON.stringify(plans.at(-1)?.arguments ?? {}).toLowerCase();
    for (const needle of PLAN_MUST_MENTION) {
      expect(planText, `plan should mention ${needle}`).toContain(needle);
    }

    // Turn 2: approve → the agent begins executing the plan. We watch for the first
    // mutating `az ... create` and abort there, rather than waiting on (or fully
    // deploying) a real VM: the assertion is that execution *starts*, so the flow
    // reaches the Execute step. Whatever the first command creates is left behind —
    // Lena never deletes, and neither does this test.
    let firstCreate = "";
    const stopOnFirstCreate = agent.subscribe((event) => {
      if (firstCreate) return;
      if (
        event.type === "tool_execution_start" &&
        event.toolName === "bash" &&
        isMutatingCommand(String(event.args?.command ?? ""))
      ) {
        firstCreate = String(event.args.command);
        agent.abort(); // stop before the slow/expensive rest of the plan runs
      }
    });
    try {
      await agent.prompt("Approved — go ahead and provision it.");
      await agent.waitForIdle();
    } finally {
      stopOnFirstCreate();
    }

    expect(
      firstCreate,
      "after approval the agent should start executing `az ... create` commands",
    ).not.toBe("");

    detachEventLogger();
  },
);
