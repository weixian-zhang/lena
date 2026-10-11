import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Byte cap on a command's output; Azure listings can be enormous. */
export const MAX_OUTPUT_BYTES = 100_000;

/** Who `az` logs in as. */
export type AzureLogin =
  | {
      kind: "servicePrincipal";
      tenantId: string;
      clientId: string;
      clientSecret: string;
    }
  | { kind: "managedIdentity" } // system-assigned
  | { kind: "userAssignedManagedIdentity"; clientId: string };

/** Runs bash commands in a working directory, with `az` logged in. */
export class AuthenticatedShell {
  /** Logged-in env, cached so `az login` runs once and every later `az` call reuses its token. */
  private loggedInEnv: Promise<NodeJS.ProcessEnv> | undefined;

  /** `workDir` is where every command runs; the caller creates it. */
  constructor(
    private readonly workDir: string,
    private readonly azureLogin: AzureLogin,
  ) {}

  /** Logs in on first call; rejects on abort, timeout or failed login. A non-zero exit resolves. */
  async run(
    command: string,
    abortSignal?: AbortSignal,
    timeoutSeconds?: number,
  ): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
    const processEnv = await (this.loggedInEnv ??= this.login());
    return runShell(command, {
      cwd: this.workDir,
      processEnv,
      abortSignal,
      timeout: timeoutSeconds,
    });
  }

  /** Logs in under a private `AZURE_CONFIG_DIR`, so concurrent shells don't share `~/.azure`. */
  private async login(): Promise<NodeJS.ProcessEnv> {
    const configDir = await mkdtemp(join(tmpdir(), "lena-az-config-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AZURE_CONFIG_DIR: configDir,
    };

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
      throw new Error(
        `az login (${this.azureLogin.kind}) failed:\n${result.output || "(no output)"}`,
      );
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
  output: string;
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
      throw new Error(
        `Unknown Azure login kind: ${JSON.stringify((login as { kind: unknown }).kind)}`,
      );
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
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
        truncated,
      });
    });
  });
}
