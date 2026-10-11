import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { Tool } from "../tool.js";

/** Byte cap on output returned to the model; Azure listings can be enormous. */
const MAX_OUTPUT_BYTES = 100_000;

/** Commands that delete files or Azure resources. Deletion is out of scope by design. */
const DELETION_PATTERN =
  /\b(rm\s+-[a-z]*[rf]|rmdir|az\b[^|;&]*\bdelete\b|--method[= ]+delete|-X[= ]*delete|\bpurge\b)/i;

/** Who `az` logs in as. */
export type AzureLogin =
  | { kind: "servicePrincipal"; tenantId: string; clientId: string; clientSecret: string }
  | { kind: "managedIdentity" } // system-assigned
  | { kind: "userAssignedManagedIdentity"; clientId: string };

const paramSchema = Type.Object({
  command: Type.String({
    description:
      "The bash command to run. Use `-o json` for `az` output you need to parse.",
  }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds. Omit for no timeout." }),
  ),
});

/** Run a bash command in `workDir` with the Azure CLI pre-authenticated as `azureLogin`. */
export class CloudShellTool implements Tool<typeof paramSchema> {
  readonly name = "bash";
  readonly description =
    "Run a bash command. Use this for Azure CLI (`az` is pre-authenticated against the target " +
    "subscription) and for any other shell tool (jq, grep, curl, git, node). " +
    "To run JavaScript, write a `.mjs` file with a quoted heredoc (`cat > x.mjs <<'EOF'`) and " +
    "run `node x.mjs` — that keeps the shell from touching the source, and gives real line " +
    "numbers in stack traces. Deleting Azure resources is out of scope and blocked.";
  readonly parameters = paramSchema;

  /** Logged-in env, cached so `az login` runs once and every later `az` call reuses its token. */
  private azureEnv: Promise<NodeJS.ProcessEnv> | undefined;

  /** `workDir` is where every command runs; the caller creates it. */
  constructor(
    private readonly workDir: string,
    private readonly azureLogin: AzureLogin,
  ) {}

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

    const env = await (this.azureEnv ??= this.loginToAzure());
    const { stdout, exitCode, truncated } = await runShell(command, {
      cwd: this.workDir,
      processEnv: env,
      abortSignal,
      timeout,
    });

    const suffix = truncated
      ? `\n\n[output truncated at ${MAX_OUTPUT_BYTES / 1000} KB — narrow the query with --query, -o tsv, or a filter]`
      : "";
    const text = (stdout || "(no output)") + suffix;

    // `null` means killed by signal — handled as abort/timeout, not a failed command.
    if (exitCode !== 0 && exitCode !== null) throw new Error(text);
    return text;
  }

  /** Logs in under a private `AZURE_CONFIG_DIR`, so concurrent tools don't share `~/.azure`. */
  private async loginToAzure(): Promise<NodeJS.ProcessEnv> {
    const configDir = await mkdtemp(join(tmpdir(), "lena-az-config-"));
    const env: NodeJS.ProcessEnv = { ...process.env, AZURE_CONFIG_DIR: configDir };

    // The secret goes through an env var so it never appears in the command string.
    const loginEnv =
      this.azureLogin.kind === "servicePrincipal"
        ? { ...env, LENA_SP_SECRET: this.azureLogin.clientSecret }
        : env;
    const result = await runShell(azLoginCommand(this.azureLogin), {
      cwd: this.workDir,
      processEnv: loginEnv,
      timeout: LOGIN_TIMEOUT_SECONDS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`az login (${this.azureLogin.kind}) failed:\n${result.stdout || "(no output)"}`);
    }
    return env;
  }
}

/** Seconds to allow `az login` before giving up. */
const LOGIN_TIMEOUT_SECONDS = 60;

/** Shell used to run commands; present on Lena's Linux/macOS hosts. */
const SHELL = "/bin/bash";

type RunShellOptions = {
  cwd: string;
  processEnv: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  /** Seconds; omit or `0` for no timeout. */
  timeout?: number;
};

type RunShellResult = {
  /** Merged stdout + stderr in arrival order, capped at {@link MAX_OUTPUT_BYTES}. */
  stdout: string;
  /** `null` when the process was terminated by a signal. */
  exitCode: number | null;
  truncated: boolean;
};

/** The `az login` command for `login`; a service principal's secret is read from `$LENA_SP_SECRET`. */
function azLoginCommand(login: AzureLogin): string {
  const quiet = "-o none --only-show-errors";
  switch (login.kind) {
    case "servicePrincipal":
      return `az login --service-principal -u '${login.clientId}' -p "$LENA_SP_SECRET" --tenant '${login.tenantId}' ${quiet}`;
    case "managedIdentity":
      return `az login --identity ${quiet}`;
    case "userAssignedManagedIdentity":
      return `az login --identity --client-id '${login.clientId}' ${quiet}`;
    default:
      throw new Error(`Unknown Azure login kind: ${JSON.stringify((login as { kind: unknown }).kind)}`);
  }
}

/**
 * Runs one command into a capped buffer. Rejects on abort, timeout or spawn error; a non-zero exit
 * resolves. The child gets its own process group so a kill takes grandchildren (`az` subprocesses) too.
 */
function runShell(
  command: string,
  options: RunShellOptions,
): Promise<RunShellResult> {
  const { cwd, processEnv, abortSignal, timeout } = options;
  if (abortSignal?.aborted) return Promise.reject(new Error("aborted"));

  return new Promise<RunShellResult>((resolve, reject) => {
    const child = spawn(SHELL, ["-c", command], {
      cwd,
      env: processEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const kill = () => {
      if (!child.pid) return;
      try {
        // Negative pid targets the whole process group on POSIX.
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Process already exited — nothing to kill.
      }
    };

    const onData = (buf: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (buf.length >= remaining) {
        chunks.push(buf.subarray(0, remaining));
        bytes = MAX_OUTPUT_BYTES;
        truncated = true;
      } else {
        chunks.push(buf);
        bytes += buf.length;
      }
    };

    const onAbort = () => kill();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout * 1000);
    }
    if (abortSignal)
      abortSignal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      cleanup();
      if (abortSignal?.aborted) return reject(new Error("aborted"));
      if (timedOut)
        return reject(new Error(`Command timed out after ${timeout} seconds`));
      // Decode once at the end so multi-byte UTF-8 is never split across chunks.
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
        truncated,
      });
    });
  });
}


