import { type Static, Type } from "typebox";
import { getAzureSession, MAX_OUTPUT_BYTES, runShell } from "./helper/cloud-shell.js";
import { DELETION_PATTERN } from "@lena/agent/tools/bash";
import type { Tool } from "./tool.js";

const paramSchema = Type.Object({
  command: Type.String({
    description: "The bash command to run. Use `-o json` for `az` output you need to parse.",
  }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds. Omit for no timeout." }),
  ),
});

/**
 * Run a bash command with the Azure CLI pre-authenticated — the `agent/tools/bash.ts`
 * tool rewritten on Lena's own `Tool` definition.
 */
export class BashTool implements Tool<typeof paramSchema> {
  readonly name = "bash";
  readonly description =
    "Run a bash command. Use this for Azure CLI (`az` is pre-authenticated against the target " +
    "subscription) and for any other shell tool (jq, grep, curl, git, node). " +
    "To run JavaScript, write a `.mjs` file with a quoted heredoc (`cat > x.mjs <<'EOF'`) and " +
    "run `node x.mjs` — that keeps the shell from touching the source, and gives real line " +
    "numbers in stack traces. Deleting Azure resources is out of scope and blocked.";
  readonly parameters = paramSchema;

  async execute(
    { command, timeout }: Static<typeof paramSchema>,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    if (DELETION_PATTERN.test(command)) {
      throw new Error(
        "Deletion is out of scope by design and is blocked. If the user needs a resource " +
          "deleted, explain how they can do it themselves or escalate — do not attempt it.",
      );
    }

    const { env, cwd } = await getAzureSession();
    const { stdout, exitCode, truncated } = await runShell(command, { cwd, env, abortSignal, timeout });

    const suffix = truncated
      ? `\n\n[output truncated at ${MAX_OUTPUT_BYTES / 1000} KB — narrow the query with --query, -o tsv, or a filter]`
      : "";
    const text = (stdout || "(no output)") + suffix;

    // `null` means killed by signal — handled as abort/timeout, not a failed command.
    if (exitCode !== 0 && exitCode !== null) throw new Error(text);
    return text;
  }
}
