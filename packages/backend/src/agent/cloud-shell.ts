import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lenaHome } from "../util/cwd.js";

// ---------------------------------------------------------------------------
// Cloud shell — the one authenticated surface Lena runs commands through.
//
// Two layers: a generic capped subprocess runner ({@link runShell}), and a
// shared, cached Azure login ({@link getAzureSession}) whose env pre-authenticates
// `az` for every command. Any tool that shells out to Azure (the `bash` tool, the
// future Resource Graph / topography module) reuses both — one `az login`, one
// working directory, one output cap.
// ---------------------------------------------------------------------------

/**
 * Maximum number of output bytes returned to the model. Azure listings (e.g.
 * `az resource list`) can be enormous; we cap what goes into the context window
 * and flag truncation so the model knows to narrow its query (filters, `--query`,
 * `-o tsv`) rather than assume it saw everything.
 */
export const MAX_OUTPUT_BYTES = 100_000;

/** Shell used to run commands. `/bin/bash` is present on Lena's Linux/macOS hosts. */
const SHELL = "/bin/bash";

export interface RunShellOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Environment for the child process (carries `AZURE_CONFIG_DIR`, secrets, PATH). */
  env: NodeJS.ProcessEnv;
  /** Aborts the command and kills its process tree when signalled. */
  signal?: AbortSignal;
  /** Timeout in seconds. Omit or `0` for no timeout. */
  timeout?: number;
}

export interface RunShellResult {
  /** Merged stdout + stderr in arrival order, capped at {@link MAX_OUTPUT_BYTES}. */
  stdout: string;
  /** Process exit code. `null` if the process was terminated by a signal. */
  exitCode: number | null;
  /** True when output was cut at the byte cap. */
  truncated: boolean;
}

/**
 * Run a single shell command, streaming stdout+stderr into a capped buffer.
 *
 * Reimplemented from Pi's `createLocalBashOperations` core (packages/coding-agent/
 * src/core/tools/bash.ts) minus its TUI coupling. On non-Windows the child is spawned
 * in its own process group (`detached`) so a timeout or abort can kill the whole tree
 * — a bare `child.kill()` would orphan grandchildren (e.g. `az` sub-processes).
 *
 * Rejects with `"aborted"`, a timeout message, or a spawn error. A non-zero exit is
 * NOT a rejection here — the caller decides how to surface it (the bash tool throws,
 * per the tool contract in CLAUDE.md).
 */
export function runShell(command: string, options: RunShellOptions): Promise<RunShellResult> {
  const { cwd, env, signal, timeout } = options;
  if (signal?.aborted) return Promise.reject(new Error("aborted"));

  return new Promise<RunShellResult>((resolve, reject) => {
    const child = spawn(SHELL, ["-c", command], {
      cwd,
      env,
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
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout * 1000);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) return reject(new Error("aborted"));
      if (timedOut) return reject(new Error(`Command timed out after ${timeout} seconds`));
      // Decode once at the end so multi-byte UTF-8 is never split across chunks.
      resolve({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code, truncated });
    });
  });
}

// ---------------------------------------------------------------------------
// Azure session — one authenticated, isolated CLI login shared by every caller.
// ---------------------------------------------------------------------------

/** Persistent working directory for agent commands: `~/.lena/work`. */
export const WORKDIR = lenaHome("work");

export interface AzureSession {
  /** Environment carrying a per-session `AZURE_CONFIG_DIR` + PATH/secrets. */
  env: NodeJS.ProcessEnv;
  /** Working directory ({@link WORKDIR}): cloning repos, staging deploy artifacts. */
  cwd: string;
}

/** Cached login. `az login` runs once; every later `az` call reuses the token. */
let session: Promise<AzureSession> | undefined;

/** Seconds to allow `az login` before giving up. */
const LOGIN_TIMEOUT_SECONDS = 60;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Resolve the shared Azure session, logging in on first use.
 *
 * A per-session `AZURE_CONFIG_DIR` isolates this process's credential cache and
 * active subscription so concurrent sessions don't clobber a shared `~/.azure`.
 * The promise is cached, so concurrent first-callers await a single `az login`
 * and everyone after reuses the warm token cache — prepending `az login` to every
 * command would instead cost a token-endpoint round trip per call.
 */
export function getAzureSession(): Promise<AzureSession> {
  return (session ??= createSession());
}

async function createSession(): Promise<AzureSession> {
  const configDir = await mkdtemp(join(tmpdir(), "lena-az-config-"));
  const cwd = WORKDIR;
  await mkdir(cwd, { recursive: true });

  const clientId = requireEnv("AZURE_CLIENT_ID");
  const clientSecret = requireEnv("AZURE_CLIENT_SECRET");
  const tenantId = requireEnv("AZURE_TENANT_ID");

  const env: NodeJS.ProcessEnv = { ...process.env, AZURE_CONFIG_DIR: configDir };

  // Pass the secret through an env var referenced as "$LENA_SP_SECRET" so the
  // literal never appears in the command string we build (and might log/stream).
  // Residual exposure: the CLI still receives it as an argv, visible in `ps`
  // inside this host. To remove even that, switch the SP to certificate auth
  // (`--password <cert.pem>`).
  const loginEnv: NodeJS.ProcessEnv = { ...env, LENA_SP_SECRET: clientSecret };
  const command =
    `az login --service-principal -u '${clientId}' -p "$LENA_SP_SECRET" ` +
    `--tenant '${tenantId}' -o none --only-show-errors`;

  const result = await runShell(command, { cwd, env: loginEnv, timeout: LOGIN_TIMEOUT_SECONDS });
  if (result.exitCode !== 0) {
    // stdout carries az's stderr (merged); the secret is not in it.
    throw new Error(`az login (service principal) failed:\n${result.stdout || "(no output)"}`);
  }

  return { env, cwd };
}
