import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";

const stepSchema = Type.Object({
  intent: Type.String({ description: "What this step accomplishes, and why it's needed." }),
  command: Type.String({
    description:
      "The exact command to run. Expected form — values that only exist at execution time " +
      "(a generated hostname, a resource id from an earlier step) may differ when you run it.",
  }),
  resources: Type.Array(Type.String(), {
    description: "The Azure resources this step creates or modifies, by name or id.",
  }),
});

const schema = Type.Object({
  title: Type.String({
    description: 'Short label for the plan, e.g. "Deploy web app with a staging slot".',
  }),
  goal: Type.String({ description: "The user's objective, restated concretely." }),
  steps: Type.Array(stepSchema, {
    description:
      "The steps, in execution order. You run these yourself with `bash`, one at a time, " +
      "only after the user approves.",
  }),
  expectedOutcome: Type.String({ description: "What is true once every step has succeeded." }),
  estimatedCost: Type.Optional(
    Type.Object(
      {
        totalMonthly: Type.String({
          description:
            'Total estimated monthly cost, summed across every resource in `perItem`, e.g. ' +
            '"~$9.64/month". Keep the currency and period consistent with the per-item figures.',
        }),
        perItem: Type.Array(Type.String(), {
          description:
            "One entry per billable resource, each naming the resource and its own estimated " +
            'cost, e.g. "Standard_B1s VM: ~$9.64/month (SEA PAYG, $0.0132/hr × 730)". Resources ' +
            "with no base charge (VNet, subnet, NIC, resource group) may be listed as $0 or omitted.",
        }),
      },
      {
        description:
          "Cost estimate for the plan: a summed `totalMonthly` plus a `perItem` breakdown whose " +
          "figures add up to it. Omit the whole field if nothing billable changes.",
      },
    ),
  ),
  risks: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "What could go wrong or surprise the user. Note when a plan can't be cleanly undone: " +
        "you cannot delete resources, so a run that fails halfway leaves what it already " +
        "created behind for the user to remove manually.",
    }),
  ),
  verification: Type.Array(Type.String(), {
    description: "Read-only checks you will run afterwards to prove the change actually worked.",
  }),
});

export type ProposePlanInput = Static<typeof schema>;

/**
 * Present a plan and stop for approval. Executes nothing — the model runs the approved
 * steps itself via `bash`, one at a time, so it sees each result before the next step
 * (CLAUDE.md: "sequential, supervised execution with reflection").
 *
 * `terminate: true` ends the run after this tool, so the model cannot follow its own plan
 * with a mutation in the same turn. Caveat: pi only terminates when *every* result in the
 * batch sets it (agent-loop.js `shouldTerminateToolBatch`), so a message batching
 * propose_plan with another call still continues. The `beforeToolCall` policy hook is
 * what closes that hole — this is a strong default, not the enforcement boundary.
 *
 * Approval is conversational: the user's next message ("approved", or a revision request)
 * starts the next run.
 */
export const proposePlanTool: AgentTool<typeof schema> = {
  name: "propose_plan",
  label: "propose plan",
  description:
    "Present a plan for changing Azure state, and stop for the user's approval. Call this " +
    "before the first mutating command of any task — provisioning, deploy, config change, " +
    "stop/scale/restart, security remediation. It runs nothing; you execute the approved " +
    "steps yourself with `bash`. Scale the detail to the change: a deployment gets every " +
    "step, a one-line config fix gets a one-step plan. To revise, call again with the full " +
    "updated plan.",
  parameters: schema,
  async execute(_toolCallId, plan) {
    // TODO(checkpoint): persist the plan and mint its id before the user is prompted, so an
    // approval can be matched back to exactly what was shown. Reference the id in the text below.

    return { content: [{
      type: "text",
      text:
        "Plan approved by the user. Nothing has run yet. Execute the steps yourself.",
    }], details: plan, terminate: false };
    // return {
    //   // Read by the model on the *next* run (after `terminate` ends this one), where it sits
    //   // just before the user's reply. Must never read as approval — some fraction of runs would
    //   // take "ok"/"accepted" as a green light.
    //   content: [
    //     {
    //       type: "text",
    //       text:
    //         "Plan presented to the user for approval. Nothing has run. Do not execute any step " +
    //         "until the user approves. If they ask for changes, call propose_plan again with the " +
    //         "revised plan.",
    //     },
    //   ],
    //   // Carried on pi's `tool_execution_end` event — the payload a frontend renders.
    //   details: plan,
    //   terminate: true,
    // };
  },
};
