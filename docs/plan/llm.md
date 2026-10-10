# LLM package: Foundry-first, pi-ai routed

## Context

Lena needs an LLM module modelled on DeepSeek Harness's `packages/llm/llm-pi-ai`: pi-ai handles provider routing and the streaming contract, and Lena owns auth and config.

**v1 scope:**
- **Provider:** Microsoft Foundry only.
- **Auth kinds:** API key, managed identity (system- or user-assigned), and service principal.
- **Model families:** GPT (Responses), other Foundry models such as DeepSeek, Mistral and Grok (Chat Completions), and Claude (Anthropic Messages).
- **Model picker:** a future desktop frontend lets users pick a model, so providers and models live in Lena's database (SQLite locally, Postgres in the cloud) and the package lists them.
- **New providers** must be additive later.

**Where it lives:** a new top-level package `packages/llm` (`@lena/llm`, the directory already exists and is empty). The current `packages/agent/llm` (pi-ai 0.85.1) is **moved and evolved**, not rewritten:
- `stream-adapter.ts` (pi-ai ⇄ Lena events and messages) and `types.ts` already work and only need small edits.
- `index.ts` and `credential.ts` change; `model.ts` folds into `ModelProfile.toPiModel()`.
- Nothing outside `packages/agent/llm` imports it today, so the move breaks no consumer.

## Research: how each Foundry model family authenticates

**Auth belongs to the Foundry resource, not the model family.**
- One credential, one Entra scope `https://ai.azure.com/.default` (Microsoft: "Tokens must be issued with scope `https://ai.azure.com/.default`"), and one RBAC role (**Cognitive Services User** / **Foundry User** on the resource) cover every deployment.
- What differs per family is the route and protocol, and therefore which header carries the credential.

| Family | Route on `https://<res>.services.ai.azure.com` | pi-ai `api` | API key header | Entra header (MI / SP) |
|---|---|---|---|---|
| Azure OpenAI (GPT-5.x, gpt-oss) | `/openai/v1` | `openai-responses` (or `openai-completions`) | `Authorization: Bearer <key>` (documented) | `Authorization: Bearer <jwt>` |
| DeepSeek, Mistral Large 3, Llama, Grok, Kimi, Cohere Command | `/openai/v1` | `openai-completions`. Responses works only for some (DeepSeek, Llama, Grok); the others return `400 Model not supported` | same | same |
| Claude (Hosted on Azure or on Anthropic) | `/anthropic` (not served on `openai.azure.com`) | `anthropic-messages` | `x-api-key` or `api-key` | `Authorization: Bearer <jwt>` |

- **Request `model`:** always the deployment name.
- **Claude hosting option:** changes features, not auth.
- **Out of scope:**
  - Legacy serverless API deployments (`*.models.ai.azure.com`) are key-only, with an endpoint and key per deployment.
  - Non-chat models (Mistral OCR/Document AI, Cohere rerank/parse).
- **No tool calling:** Llama-3.3-70B, Llama-4-Maverick and mistral-medium-3-5 cannot call tools, so they cannot drive Lena's loop.

**How this maps onto pi-ai 0.85.1:**
- `Provider.auth.apiKey.resolve()` runs **on every request** with no caching (`dist/auth/resolve.js`). It does not see the model, and it doesn't need to:
  - **API-key kind:** returns `{ auth: { apiKey } }`. The OpenAI SDK sends `Authorization: Bearer <key>` and the Anthropic SDK sends `x-api-key`. Both are accepted.
  - **MI / SP kinds:** return `{ auth: { headers: { Authorization: "Bearer <jwt>" } } }`.
    - On openai-*, `getClientApiKey` accepts header-only auth, and the default headers override the SDK's placeholder Bearer.
    - On anthropic-messages, `assertRequestAuth` accepts the header and no `x-api-key` is sent.
- **Rejected alternatives:**
  - Passing the JWT as `apiKey` fails on Anthropic, which would send it as `x-api-key`.
  - pi-ai's built-in `azure-openai-responses` provider sends `api-key`, has no Entra support, reads `AZURE_OPENAI_*` env implicitly, and covers one protocol.
  - pi-agent-core's `getApiKey` belongs to the Agent Lena is dropping.

## Decisions (the grilled plan)

1. **One pi-ai `Provider` per configured provider**, built with `createProvider`, as dsh does for non-catalog routes (`dsh provider.ts buildProvider`/`PROTOCOLS`).
   - Auth lives in that provider's `resolve()`.
   - The route key is the same value everywhere: config key, `Provider.id` and `Model.provider`. pi-ai resolution is then `models.getModel(provider, id)`.
2. **The provider owns auth and the resource; each model owns its protocol.**
   - `api` is explicit per model and is never inferred from the name.
   - Config stores the resource **name**; `baseUrlFor(resource, api)` builds `https://<res>.services.ai.azure.com/{openai/v1|anthropic}`. One host serves all three protocols.
3. **Three auth kinds, all explicit:**
   - `apiKey{apiKeyEnv}`
   - `managedIdentity{clientId?}`
   - `servicePrincipal{tenantId, clientId, clientSecretEnv}`

   Also:
   - Drop `deviceCodeUserToken` (a static token that dies in about an hour).
   - No `DefaultAzureCredential` chain and no implicit `AZURE_OPENAI_*` env.
4. **No secrets in the database.** The frontend will write the config, so the `auth` column holds env-var names only. Managed identity is the recommended production choice.
5. **The model is chosen per request.** `LLMRequest.model = { provider, id }`, so one `LLM` serves every configured model and the frontend switches freely.
6. **Fail loud.** Each of these throws with the offending value:
   - an unknown provider, model, `kind` or `api`;
   - a duplicate model id;
   - a missing secret env var;
   - a tools request to a `tools: false` model.

   `contextWindow`, `maxTokens` and `tools` are required per model; today's silent `CONTEXT_WINDOW_TOKENS` fallback is removed.
7. **Tools are `@lena/tool`'s `Tool`** (`packages/tool/tool.ts`); `@lena/llm`'s workspace dependencies are `@lena/tool` and `@lena/datastore`.
   - `LLMRequest.tools` is `readonly Tool[]`; tool results use `ToolContent`. Both are type imports from `@lena/tool/tool`, so the tool index and its built-ins never load.
   - The adapter maps each `Tool` to `{ name, description, parameters }`, so `execute` never reaches pi-ai and the `toJson()` round trip goes.
   - `@lena/tool` depends on `@lena/agent` only for `DELETION_PATTERN`. Moving that constant into `@lena/tool` breaks the future cycle `agent → llm → tool → agent`.
   - Token limits stay with the caller, so there is no `@lena/util` dependency.
8. **Drop dsh's machinery:** immutable snapshots, hot reload, catalog merging, `modelOverrides`/`compat` and a credential store.
   - Config is read once by `DbLlmConfig.load`. After a write, the caller rebuilds `PiAiLLM` from a fresh load.
   - pi-ai's default in-memory store is fine because `resolve()` ignores it.
9. **Adding a provider later** means one more `kind` variant plus one `PiAiXProvider` class.
   - For a provider pi-ai ships, that function can reuse its built-in provider with the configured models, as dsh's `reuseCatalogProvider` does.
   - Routing does not change.
10. **Config lives in the database, through a shared `@lena/datastore`.**
    - `@lena/datastore` handles connection and query execution only, and knows no module's schema. It is the only package that imports `better-sqlite3` or `pg`.
    - `@lena/llm` owns its tables, DDL and SQL, and passes them to the `Database` it is given.
    - One `Database` per process, opened by the app and shared by every store.
    - A database replaces `~/.lena/models.json`: cloud replicas share Postgres, while a file on a container disk would be lost and unshared.

## Package design: `packages/datastore` (`@lena/datastore`)

A leaf package with no `@lena/*` dependencies. It runs SQL, it doesn't know any module's tables.

```
packages/datastore/
  package.json         @lena/datastore, deps: better-sqlite3, pg
  index.ts             Database, SqliteDatabase, PostgresDatabase, openDatabase
  test/
    sqlite-database.test.ts
```

```ts
interface Database {
  readonly backend: "sqlite" | "postgres";        // for the rare query that must branch
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;   // commits, or rolls back on throw
  migrate(ddl: string): Promise<void>;            // runs a module's own idempotent DDL
  close(): Promise<void>;
}
function openDatabase(options: { mode: "LOCAL" | "CLOUD"; connection: string }): Database;
```

- **`SqliteDatabase`** (LOCAL): one better-sqlite3 handle with WAL, `foreign_keys` and `busy_timeout`, matching today's session store. Transactions run behind a queue, so an `await` inside one cannot interleave another caller's statements on the single handle.
- **`PostgresDatabase`** (CLOUD): one `pg` pool. A transaction takes a client and hands `work` a `Database` bound to that client.
- **What it normalises:** placeholders (modules write `$1`, which becomes `?1` for SQLite), and `BIGINT` returned as a number. Booleans are stored as `0`/`1` in both. SQL syntax is not translated.
- **Out of this plan:** moving `@lena/session` onto `@lena/datastore`.

## Package design: `packages/llm` (`@lena/llm`)

```
packages/llm/
  package.json         @lena/llm, exports {"./*": "./*.ts"}, deps: @earendil-works/pi-ai ^0.85.1, @azure/identity ^4.13.1, typebox, @lena/tool, @lena/datastore
  tsconfig.json        extends ../../tsconfig.base.json, excludes **/*.test.ts (copy of packages/util)
  vitest.config.ts     node env (copy of apps/gateway-agent/vitest.config.ts)
  index.ts             LLM, PiAiLLM, re-exports
  types.ts             data types only
  config.ts            typebox schema, LlmConfig / DbLlmConfig
  schema.sql           llm_providers, llm_models (portable: runs on SQLite and Postgres)
  profile.ts           ProviderProfile / DefaultProviderProfile, ModelProfile / DefaultModelProfile
  credential.ts        CredentialProvider, ApiKeyCredentialProvider, EntraCredentialProvider, credentialProviderFor
  foundry-provider.ts  FoundryProvider / PiAiFoundryProvider
  stream-adapter.ts    StreamAdapter / PiAiStreamAdapter
  test/
    config.test.ts  profile.test.ts  foundry-provider.test.ts  llm.test.ts  live.test.ts
```

**Classes vs types.** Code that holds state or groups related functions is a class implementing an
interface, following the repo's `Toolbox` / `DefaultToolbox` naming:

| Interface | Class | Role |
|---|---|---|
| `LLM` | `PiAiLLM` | streams one request on the model it names |
| `LlmConfig` | `DbLlmConfig` | providers and models loaded from the database, lookups, and saving a provider |
| `ProviderProfile` | `DefaultProviderProfile` | one configured provider: resource, auth, models (≈ dsh `PiAiProviderProfile`) |
| `ModelProfile` | `DefaultModelProfile` | one configured model (≈ dsh `PiAiModelProfile`) |
| `CredentialProvider` | `ApiKeyCredentialProvider`, `EntraCredentialProvider` | the credential for each request |
| `FoundryProvider` | `PiAiFoundryProvider` | wraps pi-ai `createProvider` with Foundry auth |
| `StreamAdapter` | `PiAiStreamAdapter` | pi-ai ⇄ Lena translation for one model |

Pure data stays `type`: `LLMRequest`, `LLMEvent`, `LLMMessage`, `LLMToolCall`, `LLMUsage`,
`LLMStopReason`, `LLMModelInfo`, `FoundryCredential`, and the raw config shapes
(`ProviderConfig`, `ModelConfig`, `AuthConfig` = `Static<>` of the schema).

**Tables (`schema.sql`)**, using only types both SQLite and Postgres accept:

```sql
CREATE TABLE IF NOT EXISTS llm_providers (
  id        TEXT PRIMARY KEY,   -- our route key, e.g. "foundry-prod"
  kind      TEXT NOT NULL,      -- "foundry"
  resource  TEXT NOT NULL,      -- Foundry resource name
  auth      TEXT NOT NULL       -- JSON auth union; env-var names only, never a secret
);
CREATE TABLE IF NOT EXISTS llm_models (
  provider_id     TEXT NOT NULL REFERENCES llm_providers(id),
  id              TEXT NOT NULL,      -- deployment name
  name            TEXT,
  api             TEXT NOT NULL,      -- openai-responses | openai-completions | anthropic-messages
  context_window  INTEGER NOT NULL,
  max_tokens      INTEGER NOT NULL,
  reasoning       INTEGER NOT NULL,   -- 0/1
  tools           INTEGER NOT NULL,   -- 0/1
  PRIMARY KEY (provider_id, id)
);
```

The same configuration as one `ProviderConfig` value, the shape `saveProvider` takes:

```jsonc
{
  "kind": "foundry",
  "resource": "<res>",
  "auth": { "kind": "managedIdentity", "clientId": "<optional user-assigned>" },
  // | { "kind": "apiKey", "apiKeyEnv": "FOUNDRY_API_KEY" }
  // | { "kind": "servicePrincipal", "tenantId": "…", "clientId": "…", "clientSecretEnv": "AZURE_CLIENT_SECRET" }
  "models": [
    { "id": "gpt-5.5", "api": "openai-responses", "contextWindow": 1050000, "maxTokens": 128000, "reasoning": true, "tools": true },
    { "id": "claude-sonnet-5-5", "api": "anthropic-messages", "contextWindow": 1000000, "maxTokens": 64000, "tools": true },
    { "id": "DeepSeek-V4-Pro", "api": "openai-completions", "contextWindow": 1000000, "maxTokens": 384000, "reasoning": true, "tools": true }
  ]
}
```

**Public surface:**

```ts
interface LLM {
  listModels(): LLMModelInfo[];                       // frontend picker
  stream(request: LLMRequest): AsyncGenerator<LLMEvent, void>;
}
class PiAiLLM implements LLM { constructor(config: LlmConfig) }
class DbLlmConfig implements LlmConfig {
  static load(database: Database): Promise<DbLlmConfig>;       // migrates, reads, validates; throws on invalid rows
  saveProvider(id: string, config: ProviderConfig): Promise<void>;  // validates, then upserts provider + its models
}
// usage: new PiAiLLM(await DbLlmConfig.load(database)); rebuild after saveProvider
// LLMRequest gains: model: { provider: string; id: string }; tools?: readonly Tool[]
// LLMModelInfo: { provider, id, name, api, contextWindow, maxTokens, reasoning, tools }
```

Following Lena's CLAUDE.md:
- exported items go first in each file;
- interface plus a class that `implements` it;
- comments are 1–3 lines.

## Step-by-step implementation

1. **Break the `tool → agent` edge.**
   - Move `DELETION_PATTERN` from `packages/agent/tools/bash.ts` into `packages/tool/builtin/bash.ts` and export it.
   - `packages/agent/tools/bash.ts` imports it from `@lena/tool`, which `agent` already depends on.
   - Remove `@lena/agent` from `packages/tool/package.json`.
   - `pnpm --filter @lena/tool typecheck && pnpm --filter @lena/tool test`.
2. **Build `@lena/datastore`.**
   - Scaffold `packages/datastore` (`package.json` with `better-sqlite3`, `pg` and their `@types`; `tsconfig.json`; `vitest.config.ts`).
   - `Database` interface, `SqliteDatabase`, `PostgresDatabase` and `openDatabase({ mode, connection })`, which throws on an unknown `mode`.
   - `$n` → `?n` placeholder rewrite for SQLite; `BIGINT` parsed as a number for Postgres.
   - `sqlite-database.test.ts` runs against a real `:memory:` database: `query`/`execute`, placeholders, `migrate` run twice, commit, rollback on throw, and two concurrent transactions that don't interleave.
3. **Scaffold `packages/llm`.**
   - `package.json` with the deps above (including `@lena/tool` and `@lena/datastore` as `workspace:*`) and scripts `typecheck`/`test`.
   - `tsconfig.json` and `vitest.config.ts`, copied from `packages/util` and `apps/gateway-agent`.
   - Run `pnpm install`.
4. **Move the existing module.**
   - `git mv packages/agent/llm/* packages/llm/` keeps history.
   - Remove `@earendil-works/pi-ai` from `packages/agent/package.json`; only `llm/` used it (`agent.ts` uses `@mariozechner/pi-ai`).
   - Keep `@azure/identity` in agent: `agent.ts` still uses `DefaultAzureCredential` until the loop migration.
5. **`types.ts`: data types only.**
   - Drop `FoundryAuth`.
   - Add `LLMModelInfo`, `FoundryCredential = { kind: "apiKey"; key } | { kind: "bearer"; token }` and `LLMRequest.model`.
   - `LLMRequest.tools` becomes `readonly Tool[]`; `toolResult.content` stays `string | ToolContent[]`. Both are type imports from `@lena/tool/tool`.
6. **`profile.ts`.**
   - `DefaultModelProfile implements ModelProfile`:
     - fields `id`, `name` (defaults to `id`), `api`, `contextWindow`, `maxTokens`, `reasoning`, `tools`;
     - `toPiModel(provider)` builds `Model<Api>`: `baseUrl` from `provider.baseUrlFor(api)`, zero cost, input `["text"]`;
     - `toInfo(providerId)` for the picker;
     - `assertAcceptsTools(tools?: readonly Tool[])` throws on a tools request to a `tools: false` model.
   - `DefaultProviderProfile implements ProviderProfile`:
     - fields `id`, `kind`, `resource`, `auth`, `models`; the constructor throws on a duplicate model id (the table's primary key is the backstop);
     - `baseUrlFor(api)` builds `https://<res>.services.ai.azure.com/{openai/v1|anthropic}` and throws on any other `api`;
     - `model(id)` throws on a miss, naming provider and id;
     - `toPiModels()`.
7. **`schema.sql` and `config.ts`.**
   - `schema.sql` holds the two tables above, written once in SQL both backends run.
   - The typebox schema covers `ProviderConfig`: `kind: "foundry"`, `resource`, the auth union, and models with `id`, `api ∈ {openai-responses, openai-completions, anthropic-messages}`, `contextWindow`, `maxTokens`, `tools`, and optional `reasoning`/`name`.
   - `DbLlmConfig.load(database)`:
     1. `database.migrate(schema.sql)`;
     2. select both tables, ordered by provider id and model id;
     3. assemble each provider's rows into a `ProviderConfig` and run `Value.Check`; an invalid row throws naming the provider and the first `Value.Errors` entry;
     4. build a `DefaultProviderProfile` for each.
   - `saveProvider(id, config)`: `Value.Check`, then `new DefaultProviderProfile(id, config)` to validate. In one `database.transaction`, it upserts the provider row, deletes that provider's model rows and inserts the new ones. Removing a model row is config, not an Azure resource.
   - Instance methods: `providers`, `provider(id)` (throws on unknown), `model({ provider, id })`, `listModels()`.
8. **`credential.ts`.**
   - `interface CredentialProvider { get(): Promise<FoundryCredential> }`.
   - `ApiKeyCredentialProvider(apiKeyEnv)` reads `process.env[apiKeyEnv]` per call and throws if it is empty.
   - `EntraCredentialProvider(tokenCredential)` wraps `getBearerTokenProvider(credential, FOUNDRY_SCOPE)`.
   - `credentialProviderFor(auth)` is the one switch on auth kind: `ManagedIdentityCredential(clientId ? { clientId } : undefined)` or `ClientSecretCredential` (throws if the secret env is unset), ending in an exhaustive `never` check.
9. **`foundry-provider.ts`.**
   - `PiAiFoundryProvider(profile, credentials: CredentialProvider)` exposes `piProvider`, built with `createProvider({ id, name: id, auth: { apiKey: { name: id, resolve } }, models: profile.toPiModels(), api: { "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi(), "anthropic-messages": anthropicMessagesApi() } })`, using the `*.lazy` imports.
   - Private `resolveAuth()` maps the credential to `{ auth: { apiKey } }` or `{ auth: { headers: { Authorization: \`Bearer ${token}\` } } }`.
   - Injecting `CredentialProvider` is the test seam for bearer auth without Entra.
10. **`stream-adapter.ts`.**
    - `PiAiStreamAdapter(model)` with `toPiContext(request)` and `toLLMEvent(event)`; today's helpers become private methods.
    - Tools map as `request.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }))`.
    - Confirm, and test, that a `resolve()` failure (bad secret, MI unavailable) arrives as a pi-ai `error` event and becomes exactly one Lena `error` event, never a throw.
11. **`index.ts`.** `class PiAiLLM implements LLM`:
    - The constructor calls `createModels()` and, for each provider, `switch (kind)` → `setProvider(new PiAiFoundryProvider(profile, credentialProviderFor(profile.auth)).piProvider)`, ending in an exhaustive `never` check.
    - `listModels()` delegates to the config.
    - `stream(request)`:
      1. `config.model(request.model)`;
      2. `assertAcceptsTools(request.tools)`;
      3. `models.getModel(provider, id)`;
      4. `new PiAiStreamAdapter(model)`;
      5. `models.streamSimple(model, adapter.toPiContext(request), { signal, temperature, maxTokens })`;
      6. map events with `adapter.toLLMEvent`.
    - No `createLLM`: callers write `new PiAiLLM(await DbLlmConfig.load(database))`.
12. **Unit tests (vitest, beside the code).** The database is a real in-memory SQLite (`openDatabase({ mode: "LOCAL", connection: ":memory:" })`); only `fetch` and the credential source are faked.
    - **`config.test.ts`:** a `saveProvider` → `load` round trip; `saveProvider` rejects an unknown `kind`/`api`, missing `contextWindow`/`tools`, an invalid auth union and a duplicate model id, writing nothing; re-saving a provider replaces its models; `load` rejects a hand-inserted invalid row; lookups throw on an unknown provider or model.
    - **`profile.test.ts`:** duplicate model id, `baseUrlFor` per protocol, `toPiModel` fields, `assertAcceptsTools`.
    - **`foundry-provider.test.ts`:** a fake `CredentialProvider` and a fake `fetch` (`ProviderRequestOptions.fetch`) assert the URL and header per request:

      | Credential | openai-* | anthropic-messages |
      |---|---|---|
      | API key | `Authorization: Bearer key` | `x-api-key` |
      | bearer | `Authorization: Bearer jwt` | `Authorization: Bearer jwt` (no `x-api-key`) |

    - **`llm.test.ts`** (`vi.stubGlobal("fetch")`): a request with a real `Tool` reaches `fetch` with only `name`, `description` and `parameters`; a tools request to a `tools: false` model throws; an unset `apiKeyEnv` yields exactly one `error` event.
13. **Live test (`test/live.test.ts`, skips without env).**
    - Seeds an in-memory SQLite through `saveProvider` from env, then builds `PiAiLLM` from `DbLlmConfig.load`.
    - Keeps its shape: `Tool` objects with `execute`, passed as `tools: [tool]`, results from `tool.execute(...)`.
    - Run {GPT via Responses, DeepSeek via Completions, Claude via Messages} × {API key, service principal} against one Foundry resource.
    - Each case asserts a text reply and one tool-call round trip. The DeepSeek case also asserts `thinking` events; if they are missing, add an optional `compat` to the model schema then.
    - Managed identity, system- and user-assigned, is run once from an Azure-hosted environment.
14. **Typecheck and test:** `pnpm --filter @lena/tool test`, `pnpm --filter @lena/datastore test`, `pnpm --filter @lena/llm typecheck && pnpm --filter @lena/llm test`, plus `pnpm -r typecheck`.

## Out of scope (noted gaps)

- **Moving `agent.ts` / `apps/gateway-agent` off pi 0.73 + `DefaultAzureCredential` onto `@lena/llm`.** This belongs with `docs/plan/agent-loop.md`. Its `LoopOptions.llm: LLM` now imports from `@lena/llm`, and the loop passes `model` per request.
- **Moving `@lena/session` onto `@lena/datastore`.** Its two stores collapse into one over `Database`; a plan of its own.
- **Wiring the app:** opening the one `Database` from `MODE` and the connection string at startup, and passing it to every store.
- **The frontend and API that call `saveProvider`**, and removing a whole provider.
- **First run with an empty database.** No provider means no model; the frontend's first-run step, or an env seed, fills it.
- **Hot reload.** Callers rebuild `PiAiLLM` after a save. If a live swap is ever needed, dsh's snapshot-per-config pattern (`adapter.ts current()`) is the reference.
- **Reasoning-effort selection, and image input** beyond what `ToolContent` replays.
- **`Toolbox.list(): Tool[]`.** The loop holds a `Toolbox`, which can't list its tools today; add `list()` when the loop moves onto `@lena/llm`.

## Verification

- Steps 12–14 above.
- The plan is done when:
  - all unit tests pass, including `@lena/datastore`'s;
  - the live matrix passes for API key and service principal;
  - `pnpm -r typecheck` is green.

## Sources

- [Foundry endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)
- [Entra ID keyless auth](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id)
- [Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- dsh reference: `deepseek-harness/packages/llm/llm-pi-ai/src/{provider,adapter,config}.ts`
