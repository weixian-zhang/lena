import {
  ClientSecretCredential,
  getBearerTokenProvider,
  ManagedIdentityCredential,
  type TokenCredential,
} from "@azure/identity";

/**
 * Entra ID scope for Microsoft Foundry inference.
 *
 * @see https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id
 */
const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

/**
 * How Lena authenticates to Foundry: Entra ID only, never an API key. The two managed identities are
 * separate kinds so a missing `clientId` can't fall back silently to the system-assigned one.
 */
export type AuthConfig =
  | {
      kind: "servicePrincipal";
      tenantId: string;
      clientId: string;
      /** Name of the env var holding the client secret; the secret itself never sits in config. */
      clientSecretEnv: string;
    }
  | { kind: "systemAssignedManagedIdentity" }
  | { kind: "userAssignedManagedIdentity"; clientId: string };

/** Builds the Entra credential the auth config names; throws if a service principal's secret env var is unset. */
export function createTokenCredential(auth: AuthConfig): TokenCredential {
  switch (auth.kind) {
    case "servicePrincipal": {
      const secret = process.env[auth.clientSecretEnv];
      if (!secret)
        throw new Error(
          `Service principal secret env var "${auth.clientSecretEnv}" is not set.`,
        );
      return new ClientSecretCredential(auth.tenantId, auth.clientId, secret);
    }
    case "systemAssignedManagedIdentity":
      return new ManagedIdentityCredential();
    case "userAssignedManagedIdentity":
      return new ManagedIdentityCredential({ clientId: auth.clientId });
    default: {
      const unknown: never = auth;
      throw new Error(`Unknown auth kind: ${JSON.stringify(unknown)}.`);
    }
  }
}

/** The Foundry bearer token for each request, as the OpenAI client's `apiKey`; @azure/identity caches and refreshes it. */
export function createFoundryTokenProvider(
  credential: TokenCredential,
): () => Promise<string> {
  return getBearerTokenProvider(credential, FOUNDRY_SCOPE);
}
