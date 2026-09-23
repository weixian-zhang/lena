import {
  ClientSecretCredential,
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import type { FoundryAuth } from "./types.js";

/**
 * Entra ID scope for Microsoft Foundry inference.
 *
 * @see https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id
 */
export const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

/**
 * Returns a callable yielding the secret to send as the request's bearer
 * credential. Resolved per model call so an Entra token stays fresh across
 * long-running turns; an API key simply resolves to itself.
 */
export function createFoundryTokenProvider(auth: FoundryAuth): () => Promise<string> {
  switch (auth.kind) {
    case "apiKey":
      return async () => auth.key;
    case "systemAssignedManagedIdentity":
      return getBearerTokenProvider(new ManagedIdentityCredential(), FOUNDRY_SCOPE);
    case "servicePrincipal":
      return getBearerTokenProvider(
        new ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret),
        FOUNDRY_SCOPE,
      );
  }
}
