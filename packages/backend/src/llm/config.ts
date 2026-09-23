/** Foundry connection settings, read from the environment. */
export type FoundryConfig = {
  /** Foundry endpoint URL serving the OpenAI-compatible API. */
  endpoint: string;
  /** Model deployment name sent as each request's `model` field. */
  deploymentName: string;
};

/**
 * Resolve the Foundry endpoint + deployment from the environment.
 *
 * Credentials are not read here — the caller picks those and passes them in.
 */
export function loadFoundryConfig(): FoundryConfig {
  return {
    endpoint: requireEnv("MICROSOFT_FOUNDRY_ENDPOINT"),
    deploymentName: requireEnv("MICROSOFT_FOUNDRY_DEPLOYMENT_NAME", ["AI_FOUNDRY_DEPLOYMENT_NAME"]),
  };
}

/**
 * Read a required environment variable, trying `fallbacks` in order if `name`
 * is unset or blank. Throws naming every variable it tried.
 */
function requireEnv(name: string, fallbacks: string[] = []): string {
  const names = [name, ...fallbacks];
  for (const candidate of names) {
    const value = process.env[candidate];
    if (value && value.trim().length > 0) return value.trim();
  }
  throw new Error(`Missing required environment variable: ${names.join(" / ")}`);
}
