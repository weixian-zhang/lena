import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { LLM_APIS } from "./types.js";

/** How Lena authenticates to a provider: Entra ID only, never an API key. */
export type AuthConfig = Static<typeof AuthConfigSchema>;
/** One model a provider serves; `id` is the deployment name sent on each request. */
export type ModelConfig = Static<typeof ModelConfigSchema>;
/** One configured provider: where it is, how to authenticate, and the models it serves. */
export type ProviderConfig = Static<typeof ProviderConfigSchema>;

/** Throws naming the provider and the first problem: a schema violation or a model id listed twice. */
export function assertValidProviderConfig(
  id: string,
  config: unknown,
): asserts config is ProviderConfig {
  if (id.length === 0) throw new Error("Provider id must not be empty.");
  if (!Value.Check(ProviderConfigSchema, config)) {
    const [first] = Value.Errors(ProviderConfigSchema, config);
    throw new Error(
      `Provider "${id}" is invalid at ${first?.instancePath || "/"}: ${first?.message}.`,
    );
  }
  const seen = new Set<string>();
  for (const model of config.models) {
    if (seen.has(model.id))
      throw new Error(
        `Provider "${id}" lists model "${model.id}" more than once.`,
      );
    seen.add(model.id);
  }
}

const AuthConfigSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("managedIdentity"),
      clientId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("servicePrincipal"),
      tenantId: Type.String({ minLength: 1 }),
      clientId: Type.String({ minLength: 1 }),
      clientSecretEnv: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const ModelConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Enum(LLM_APIS),
    contextWindow: Type.Integer({ minimum: 1 }),
    maxTokens: Type.Integer({ minimum: 1 }),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ProviderConfigSchema = Type.Object(
  {
    kind: Type.Literal("foundry"),
    resource: Type.String({ minLength: 1 }),
    auth: AuthConfigSchema,
    models: Type.Array(ModelConfigSchema),
  },
  { additionalProperties: false },
);
