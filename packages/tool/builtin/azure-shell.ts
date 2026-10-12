import { type Static, Type } from "typebox";
import type { Tool } from "../tool.js";
import { AuthenticatedShell, type AzureLogin, MAX_OUTPUT_BYTES } from "./helper/authenticated-shell.js";

/** Commands that delete files or Azure resources. Deletion is out of scope by design. */
const DELETION_PATTERN =
  /\b(rm\s+-[a-z]*[rf]|rmdir|az\b[^|;&]*\bdelete\b|--method[= ]+delete|-X[= ]*delete|\bpurge\b)/i;

const paramSchema = Type.Object({
  command: Type.String({
    description: "The bash command to run. Use `-o json` for `az` output you need to parse.",
  }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Omit for no timeout." })),
});

/** Run a bash command in `workDir` with the Azure CLI pre-authenticated as `azureLogin`. */
export class AzureShellTool implements Tool<typeof paramSchema> {
  readonly name = "bash";
  readonly description =
    "Run a bash command. Use this for Azure CLI (`az` is pre-authenticated against the target " +
    "subscription) and for any other shell tool (jq, grep, curl, git, node). " +
    "To run JavaScript, write a `.mjs` file with a quoted heredoc (`cat > x.mjs <<'EOF'`) and " +
    "run `node x.mjs` — that keeps the shell from touching the source, and gives real line " +
    "numbers in stack traces. Deleting Azure resources is out of scope and blocked.";
  readonly parameters = paramSchema;

  private readonly shell: AuthenticatedShell;

  /** `workDir` is where every command runs; the caller creates it. */
  constructor(workDir: string, azureLogin: AzureLogin) {
    this.shell = new AuthenticatedShell(workDir, azureLogin);
  }

  async execute({ command, timeout }: Static<typeof paramSchema>, abortSignal?: AbortSignal): Promise<string> {
    if (DELETION_PATTERN.test(command)) {
      throw new Error(
        "Deletion is out of scope by design and is blocked. If the user needs a resource " +
          "deleted, explain how they can do it themselves or escalate — do not attempt it.",
      );
    }

    const { output, exitCode, truncated } = await this.shell.run(command, abortSignal, timeout);

    const suffix = truncated
      ? `\n\n[output truncated at ${MAX_OUTPUT_BYTES / 1000} KB — narrow the query with --query, -o tsv, or a filter]`
      : "";
    const text = (output || "(no output)") + suffix;

    // `null` means killed by signal — handled as abort/timeout, not a failed command.
    if (exitCode !== 0 && exitCode !== null) throw new Error(text);
    return text;
  }
}
