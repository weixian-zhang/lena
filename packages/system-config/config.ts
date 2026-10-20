import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Where Lena runs: `local` on a dev machine (SQLite), `cloud` on Azure (Postgres). */
export type Mode = "local" | "cloud";
/** The `.env` at the repository root; absent in the cloud. */
const REPO_ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

/** Lena's process-wide settings, read from environment variables. In local dev the repo's `.env` supplies them. */
export class SystemConfig {
  private static instance: SystemConfig | undefined;

  readonly mode: Mode;
  /** Absolute path of Lena's working directory. */
  readonly cwd: string;
  /** Hard cap on model calls in one agent turn. */
  readonly maxStep: number;

  /** The process-wide config, loaded once on first call. */
  static global(): SystemConfig {
    SystemConfig.instance ??= SystemConfig.loadFromEnv();
    return SystemConfig.instance;
  }

  /**
   * Loads `envFile` into `process.env` when it exists, then reads `process.env`. Variables already
   * set win over the file, so values injected in the cloud are never overridden.
   */
  static loadFromEnv(envFile: string = REPO_ENV_FILE): SystemConfig {
    if (existsSync(envFile)) process.loadEnvFile(envFile);

    return new SystemConfig(process.env);
  }

  /** Throws naming the variable when one is missing or invalid. */
  constructor(env: Readonly<Record<string, string | undefined>>) {
    const mode = getEnv(env, "LENA_MODE");
    if (mode !== "local" && mode !== "cloud")
      throw new Error(`LENA_MODE must be "local" or "cloud"; got "${mode}".`);

    const cwd = getEnv(env, "CWD");
    if (!isAbsolute(cwd))
      throw new Error(`CWD must be an absolute path; got "${cwd}".`);

    const maxStep = getEnv(env, "MAX_STEP");
    if (!/^[1-9]\d*$/.test(maxStep))
      throw new Error(`MAX_STEP must be a positive integer; got "${maxStep}".`);

    this.mode = mode;
    this.cwd = cwd;
    this.maxStep = Number(maxStep);
  }
}

function getEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set.`);

  return value;
}
