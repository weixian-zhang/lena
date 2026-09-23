import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";

/** Max predefined choices. The frontend appends its own "Other (type your own)" row. */
const MAX_CHOICES = 4;

const schema = Type.Object({
  question: Type.String({
    description:
      'The question, and only the question (e.g. "Which subscription — prod or dev?"). Never ' +
      "enumerate the options inside this string; pass them as `choices` so the UI renders them " +
      "as pickable rows rather than dead prose the user can't select.",
  }),
  choices: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: MAX_CHOICES,
      description:
        "Selectable options, each its own element (up to 4). The UI renders them as rows and " +
        'auto-appends an "Other (type your own)" option, so never add one yourself. Omit this ' +
        "parameter entirely for a genuinely open-ended, free-text question.",
    }),
  ),
});

export type ClarifyInput = Static<typeof schema>;

/** Payload carried on `tool_execution_end` → the `clarification` operation type the UI renders. */
export interface ClarifyDetails {
  question: string;
  /** Absent for an open-ended question. */
  choices?: string[];
}

/**
 * Coerce one choice into its display string.
 *
 * The schema declares choices as bare strings, but models sometimes emit dict-shaped
 * choices ({label|description|text|title: "..."}). A plain `String(c)` would leak the
 * object's repr onto every surface that renders the choice AND return it verbatim as the
 * answer. Normalising here — the one place choices enter — fixes the whole class at once.
 * Ported from Hermes's clarify tool (`_flatten_choice`): a documented, real LLM failure mode.
 * `name`/`value` are deliberately excluded — component-shaped fields, not human labels.
 */
function flattenChoice(choice: unknown): string {
  if (typeof choice === "string") return choice.trim();
  if (Array.isArray(choice)) return choice.map(flattenChoice).join(" ").trim();
  if (choice && typeof choice === "object") {
    for (const key of ["label", "description", "text", "title"] as const) {
      const value = (choice as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return ""; // no human-readable key → drop it; a garbage label is worse than no choice
  }
  return choice == null ? "" : String(choice).trim();
}

/** Clean, cap, and collapse to `undefined` (open-ended) when nothing usable remains. */
function normalizeChoices(choices: unknown): string[] | undefined {
  if (!Array.isArray(choices)) return undefined;
  const cleaned = choices.map(flattenChoice).filter((s) => s.length > 0).slice(0, MAX_CHOICES);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Ask the user a question and stop for their answer — the `clarification` output type.
 *
 * Adapted from Hermes's clarify tool. Hermes blocks on a platform callback that returns
 * the answer inline; Lena has no interaction channel yet, so this follows the same
 * terminate-and-resume pattern as `propose_plan`: `terminate: true` ends the turn,
 * and the user's next message is the answer. Same batch caveat — pi only terminates when
 * *every* result in the batch sets it (agent-loop.js `shouldTerminateToolBatch`).
 */
export const clarifyTool: AgentTool<typeof schema> = {
  name: "clarify",
  label: "clarify",
  description:
    "Ask the user a question when you need clarification, feedback, or a decision before " +
    "proceeding. Two modes:\n" +
    "1. Multiple choice — up to 4 `choices`. The user picks one, or types their own via an " +
    "auto-appended 'Other' option.\n" +
    "2. Open-ended — omit `choices`. The user types a free-form response.\n" +
    "CRITICAL: put each option ONLY in `choices`, NEVER inside `question` — the UI renders " +
    "`choices` as selectable rows; options in the question text are dead prose the user can't " +
    "pick. Right: question='Which deployment target?', choices=['staging','prod']. Wrong: " +
    "question='Which target? 1) staging 2) prod', choices=[].\n" +
    "Ends your turn; the user's next message is their answer. Don't use it for low-stakes calls " +
    "you can default, or to confirm a mutation — propose_plan's approval gate covers that.",
  parameters: schema,
  async execute(_toolCallId, input) {
    const question = input.question?.trim();
    if (!question) throw new Error("clarify requires a non-empty question.");

    const choices = normalizeChoices(input.choices);
    const details: ClarifyDetails = choices ? { question, choices } : { question };

    return {
      // Read by the model on the *next* run, just before the user's reply. Must never read as
      // an answer — the model has to wait for the real one.
      content: [
        {
          type: "text",
          text:
            "Question presented to the user. Nothing else has run. Wait for their reply — it " +
            "arrives as their next message — and do not assume an answer. Continue once they respond.",
        },
      ],
      // Carried on pi's `tool_execution_end` event — the payload the frontend renders as a picker.
      details,
      terminate: true,
    };
  },
};
