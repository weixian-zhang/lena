import {
  ClientSecretCredential,
  ManagedIdentityCredential,
  type TokenCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import type { AuthConfig } from "./provider-config.js";

/**
 * Entra ID scope for Microsoft Foundry inference.
 *
 * @see https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id
 */
export const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

/** Supplies the bearer token for each model request. */
export interface CredentialProvider {
  getToken(): Promise<string>;
}

/** An Entra token for Foundry, cached by `@azure/identity` and refreshed before it expires. */
export class EntraCredentialProvider implements CredentialProvider {
  private readonly getBearerToken: () => Promise<string>;

  constructor(credential: TokenCredential) {
    this.getBearerToken = getBearerTokenProvider(credential, FOUNDRY_SCOPE);
  }

  getToken(): Promise<string> {
    return this.getBearerToken();
  }
}

/** Builds the Entra credential the auth config names; throws if a service principal's secret env var is unset. */
export function createCredentialProviderFromAuthConfig(
  auth: AuthConfig,
): CredentialProvider {
  switch (auth.kind) {
    case "managedIdentity":
      return new EntraCredentialProvider(
        auth.clientId
          ? new ManagedIdentityCredential({ clientId: auth.clientId })
          : new ManagedIdentityCredential(),
      );
    case "servicePrincipal": {
      const secret = process.env[auth.clientSecretEnv];
      if (!secret)
        throw new Error(
          `Service principal secret env var "${auth.clientSecretEnv}" is not set.`,
        );
      return new EntraCredentialProvider(
        new ClientSecretCredential(auth.tenantId, auth.clientId, secret),
      );
    }
    default: {
      const unknown: never = auth;
      throw new Error(`Unknown auth kind: ${JSON.stringify(unknown)}.`);
    }
  }
}
