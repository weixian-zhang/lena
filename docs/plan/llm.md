# LLM package: Foundry-first, pi-ai routed

## Context

Lena needs an LLM module modelled on DeepSeek Harness's `packages/llm/llm-pi-ai`: pi-ai handles provider routing and the streaming contract, and Lena owns auth and config.

**v1 scope:**
- **Provider:** Microsoft Foundry only.
- **Auth kinds:** Entra ID only: managed identity (system- or user-assigned) and service principal. Foundry API keys are not supported.
- **Model families:** GPT (Responses), other Foundry models such as DeepSeek, Mistral and Grok (Chat Completions), and Claude (Anthropic Messages).
- **Model picker:** a future desktop frontend lets users pick a model, so providers and models live in Lena's database (SQLite locally, Postgres in the cloud) and the package lists them.
- **New providers** must be additive later.

**The old agent is archived.** `packages/agent` now lives at `packages/archive/agent`, outside the pnpm workspace, so `@lena/agent` no longer resolves. Nothing new depends on it. After this LLM module, the agent loop is built from scratch on `@lena/llm` (`docs/plan/agent-loop.md`).

**Where it lives:** a new top-level package `packages/llm` (`@lena/llm`, the directory already exists and is empty). The archived `packages/archive/agent/llm` (pi-ai 0.85.1) is **moved and evolved**, not rewritten:
- `stream-adapter.ts` (pi-ai ⇄ Lena events and messages) and `types.ts` already work and only need small edits.
- `index.ts` and `credential.ts` change; `model.ts` folds into `PiAiFoundryProvider`, which builds each pi-ai `Model`.
- Nothing outside the archived `llm/` imports it, so the move breaks no consumer.

## Research: how each Foundry model family authenticates

**Auth belongs to the Foundry resource, not the model family.**
- One credential, one Entra scope `https://ai.azure.com/.default` (Microsoft: "Tokens must be issued with scope `https://ai.azure.com/.default`"), and one RBAC role (**Cognitive Services User** / **Foundry User** on the resource) cover every deployment.
- What differs per family is the route and protocol, and therefore which header carries the credential.

| Family | Route on `https://<res>.services.ai.azure.com` | pi-ai `api` | Entra header (MI / SP) |
|---|---|---|---|
| Azure OpenAI (GPT-5.x, gpt-oss) | `/openai/v1` | `openai-responses` (or `openai-completions`) | `Authorization: Bearer <jwt>` |
| DeepSeek, Mistral Large 3, Llama, Grok, Kimi, Cohere Command | `/openai/v1` | `openai-completions`. Responses works only for some (DeepSeek, Llama, Grok); the others return `400 Model not supported` | same |
| Claude (Hosted on Azure or on Anthropic) | `/anthropic` (not served on `openai.azure.com`) | `anthropic-messages` | `Authorization: Bearer <jwt>` |

- **Why Entra only:** no long-lived key to store, rotate or leak, and access is governed by RBAC on the resource.

- **Request `model`:** always the deployment name.
- **Claude hosting option:** changes features, not auth.
- **Out of scope:**
  - Legacy serverless API deployments (`*.models.ai.azure.com`) are key-only, with an endpoint and key per deployment.
  - Non-chat models (Mistral OCR/Document AI, Cohere rerank/parse).
- **No tool calling:** Llama-3.3-70B, Llama-4-Maverick and mistral-medium-3-5 cannot call tools, so they cannot drive Lena's loop.

**How this maps onto pi-ai 0.85.1:**
- `Provider.auth.apiKey.resolve()` runs **on every request** with no caching (`dist/auth/resolve.js`). It does not see the model, and it doesn't need to. Despite its name, `apiKey` is pi-ai's only non-OAuth auth hook; Lena returns a header from it, never a key:
  - It returns `{ auth: { headers: { Authorization: "Bearer <jwt>" } } }`.
    - On openai-*, `getClientApiKey` accepts header-only auth, and the default headers override the SDK's placeholder Bearer.
    - On anthropic-messages, `assertRequestAuth` accepts the header and no `x-api-key` is sent.
- **Rejected alternatives:**
  - Passing the JWT as `apiKey` fails on Anthropic, which would send it as `x-api-key`.
  - pi-ai's built-in `azure-openai-responses` provider sends `api-key`, has no Entra support, reads `AZURE_OPENAI_*` env implicitly, and covers one protocol.
  - pi-agent-core's `getApiKey` belongs to the archived agent's pi-agent-core `Agent`.

## Decisions (the grilled plan)

1. **One pi-ai `Provider` per configured provider**, built with `createProvider`, as dsh does for non-catalog routes (`dsh provider.ts buildProvider`/`PROTOCOLS`).
   - Auth lives in that provider's `resolve()`.
   - The route key is the same value everywhere: config key, `Provider.id` and `Model.provider`. pi-ai resolution is then `models.getModel(provider, id)`.
2. **The provider owns auth and the resource; each model owns its protocol.**
   - `api` is explicit per model and is never inferred from the name.
   - Config stores the resource **name**; `baseUrlFor(resource, api)` builds `https://<res>.services.ai.azure.com/{openai/v1|anthropic}`. One host serves all three protocols.
3. **Two auth kinds, both Entra ID and both explicit:**
   - `managedIdentity{clientId?}`
   - `servicePrincipal{tenantId, clientId, clientSecretEnv}`

   Also:
   - No Foundry API keys: an `apiKey` auth kind is rejected by the schema.
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
   - `@lena/tool` no longer imports the archived `@lena/agent`: the bash tool is now `AzureShellTool` (`packages/tool/builtin/azure-shell.ts`), which owns `DELETION_PATTERN`. Only a stale `@lena/agent` line in `packages/tool/package.json` remains; removing it keeps the new agent loop free of the cycle `agent → llm → tool → agent`.
   - Token limits stay with the caller, so there is no `@lena/util` dependency.
8. **Drop dsh's machinery:** immutable snapshots, hot reload, catalog merging, `modelOverrides`/`compat` and a credential store.
   - Config is read once by `SqlModelConfigStore.load`. After a write, the caller rebuilds `PiAiLLM` from a fresh load.
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
  tsconfig.json        copy of packages/tool (typechecks the tests too)
  database.ts          Database interface, DatabaseMode (leaf: both backends import it)
  sqlite-database.ts   SqliteDatabase
  postgres-database.ts PostgresDatabase
  index.ts             openDatabase, re-exports
  test/
    sqlite-database.test.ts
```

```ts
interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;   // one statement, DDL included
  close(): Promise<void>;
}
function openDatabase(options: { mode: "LOCAL" | "CLOUD"; connection: string }): Database;
```

- **`SqliteDatabase`** (LOCAL): one better-sqlite3 handle with WAL, `foreign_keys` and `busy_timeout`, matching today's session store.
- **`PostgresDatabase`** (CLOUD): one `pg` pool.
- **What it normalises:** placeholders and `BIGINT`. Modules write `$1`, `$2`, … for both backends; SQLite reads `$1` as a parameter named `1`, so `SqliteDatabase` binds the array as `{ "1": …, "2": … }` and never rewrites SQL text. PostgreSQL `BIGINT` is returned as a number, and throws outside the safe-integer range. Booleans are stored as `0`/`1` in both. SQL syntax is not translated, so modules write SQL both backends run.
- **Kept basic on purpose:** no transactions, no migration runner, no backend flag. Each is added when a caller needs it.
- **Out of this plan:** moving `@lena/session` onto `@lena/datastore`.

## Package design: `packages/llm` (`@lena/llm`)

```
packages/llm/
  package.json         @lena/llm, exports {"./*": "./*.ts"}, deps: @earendil-works/pi-ai ^0.85.1, @azure/identity ^4.13.1, typebox, @lena/tool, @lena/datastore
  tsconfig.json        extends ../../tsconfig.base.json, excludes **/*.test.ts (copy of packages/util)
  vitest.config.ts     node env (copy of apps/gateway-agent/vitest.config.ts)
  index.ts             LLM, PiAiLLM, re-exports
  types.ts             data types only
  model-config-store.ts  table DDL, typebox schema, ModelConfigStore / SqlModelConfigStore
  credential.ts        CredentialProvider, EntraCredentialProvider, credentialProviderFor
  foundry-provider.ts  FoundryProvider / PiAiFoundryProvider
  stream-adapter.ts    StreamAdapter / PiAiStreamAdapter
  test/
    model-config-store.test.ts  foundry-provider.test.ts  stream-adapter.test.ts  llm.test.ts  live.test.ts
```

**Classes vs types.** Code that holds state or groups related functions is a class implementing an
interface, following the repo's `Toolbox` / `DefaultToolbox` naming:

| Interface | Class | Role |
|---|---|---|
| `LLM` | `PiAiLLM` | streams one request on the model it names |
| `ModelConfigStore` | `SqlModelConfigStore` | reads and saves provider and model config in the database, and looks models up |
| `CredentialProvider` | `EntraCredentialProvider` | a fresh Entra token for each request |
| `FoundryProvider` | `PiAiFoundryProvider` | turns one `ProviderConfig` into a pi-ai provider: base URLs, pi-ai models, Foundry auth |
| `StreamAdapter` | `PiAiStreamAdapter` | pi-ai ⇄ Lena translation for one model |

Pure data stays `type`: `LLMRequest`, `LLMEvent`, `LLMMessage`, `LLMToolCall`, `LLMUsage`,
`LLMStopReason`, `LLMModelInfo`, and the raw config shapes
(`ProviderConfig`, `ModelConfig`, `AuthConfig` = `Static<>` of the schema). A provider and its models
are plain data; there are no per-provider or per-model classes.

**Tables (DDL constants in `model-config-store.ts`)**, using only types both SQLite and Postgres accept:

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
class PiAiLLM implements LLM { constructor(store: ModelConfigStore) }
class SqlModelConfigStore implements ModelConfigStore {
  static load(database: Database): Promise<SqlModelConfigStore>;  // creates tables if missing, reads, validates; throws on invalid rows
  saveProvider(id: string, config: ProviderConfig): Promise<void>;  // validates, then upserts provider + its models
  readonly providers: ReadonlyMap<string, ProviderConfig>;
  findModel(ref: { provider: string; id: string }): { provider: ProviderConfig; model: ModelConfig };  // throws on a miss
  listModels(): LLMModelInfo[];
}
// usage: new PiAiLLM(await SqlModelConfigStore.load(database)); rebuild after saveProvider
// LLMRequest gains: model: { provider: string; id: string }; tools?: readonly Tool[]
// LLMModelInfo: { provider, id, name, api, contextWindow, maxTokens, reasoning, tools }
```

Following Lena's CLAUDE.md:
- exported items go first in each file;
- interface plus a class that `implements` it;
- comments are 1–3 lines.

## Step-by-step implementation

1. **Detach the workspace from the archived agent.** ✅ *Done.*
   - `git mv packages/agent packages/archive/agent`; the archive sits outside the `packages/*` workspace glob.
   - `@lena/tool` was already detached in code (`AzureShellTool` in `builtin/azure-shell.ts` owns `DELETION_PATTERN`); its leftover `@lena/agent` dependency line is removed.
   - The `@lena/agent` dependency line is removed from `@lena/session`, `@lena/recce` and `apps/gateway-agent`. Their `@lena/agent/*` imports stay broken until the agent loop rebuilds them, so they are left out of this plan's typecheck.
   - Verified: `pnpm install` resolves 7 workspace projects; `@lena/tool` typechecks and its 27 tests pass.
2. **Build `@lena/datastore`.** ✅ *Done.*
   - `packages/datastore`: `package.json` (`better-sqlite3`, `pg` and their `@types`) and `tsconfig.json`. No `vitest.config.ts`: vitest's defaults find `test/*.test.ts` in a node environment, as in `@lena/tool`.
   - `database.ts` (`Database`, `DatabaseMode`), `sqlite-database.ts` (`SqliteDatabase`), `postgres-database.ts` (`PostgresDatabase`), and `index.ts` with `openDatabase({ mode, connection })`, which throws on an unknown `mode`.
   - Placeholders: better-sqlite3 rejects positional `?1` with an array, so instead of rewriting `$n` → `?n`, SQLite binds `$n` by name. `$n` inside a string literal stays text.
   - Postgres: a pool-local type parser returns `BIGINT` as a number and throws outside the safe-integer range. Not exercised yet: there is no Postgres in the test run.
   - Verified: `test/sqlite-database.test.ts` runs 7 tests against a real `:memory:` database (LOCAL opens SQLite, unknown mode throws, DDL/insert/select, reused and literal `$n`, `rowCount`, missing parameter throws); typecheck is clean.
3. **Scaffold `packages/llm`.**
   - `package.json` with the deps above (including `@lena/tool` and `@lena/datastore` as `workspace:*`) and scripts `typecheck`/`test`.
   - `tsconfig.json` and `vitest.config.ts`, copied from `packages/util` and `apps/gateway-agent`.
   - Run `pnpm install`.
4. **Move the existing module.**
   - `git mv packages/archive/agent/llm/* packages/llm/` keeps history.
   - The rest of the archive stays as reference and is not built.
5. **`types.ts`: data types only.**
   - Drop `FoundryAuth`.
   - Add `LLMModelInfo` and `LLMRequest.model`.
   - `LLMRequest.tools` becomes `readonly Tool[]`; `toolResult.content` stays `string | ToolContent[]`. Both are type imports from `@lena/tool/tool`.
6. **`model-config-store.ts`.**
   - The two `CREATE TABLE IF NOT EXISTS` statements above are constants, written once in SQL both backends run.
   - The typebox schema covers `ProviderConfig`: `kind: "foundry"`, `resource`, the auth union, and models with `id`, `api ∈ {openai-responses, openai-completions, anthropic-messages}`, `contextWindow`, `maxTokens`, `tools`, and optional `reasoning`/`name`. `ProviderConfig`, `ModelConfig` and `AuthConfig` are its `Static<>` types.
   - `SqlModelConfigStore.load(database)`:
     1. `database.execute` each `CREATE TABLE IF NOT EXISTS`;
     2. select both tables, ordered by provider id and model id;
     3. assemble each provider's rows into a `ProviderConfig` and run `Value.Check`; an invalid row throws naming the provider and the first `Value.Errors` entry.
   - `saveProvider(id, config)`: `Value.Check` and a duplicate-model-id check (naming the id) run first, so invalid input writes nothing. Then it upserts the provider row (`INSERT … ON CONFLICT (id) DO UPDATE`), deletes that provider's model rows and inserts the new ones. Removing a model row is config, not an Azure resource.
   - `providers`; `findModel({ provider, id })` returns `{ provider, model }` and throws on a miss, naming provider and id; `listModels()` maps every model to `LLMModelInfo` (`name` defaults to `id`).
7. **`credential.ts`.**
   - `interface CredentialProvider { getToken(): Promise<string> }`.
   - `EntraCredentialProvider(tokenCredential)` wraps `getBearerTokenProvider(credential, FOUNDRY_SCOPE)`.
   - `credentialProviderFor(auth)` is the one switch on auth kind: `ManagedIdentityCredential(clientId ? { clientId } : undefined)` or `ClientSecretCredential` (throws if the secret env is unset), each wrapped in `EntraCredentialProvider`, ending in an exhaustive `never` check.
8. **`foundry-provider.ts`.**
   - `PiAiFoundryProvider(id, config: ProviderConfig, credentials: CredentialProvider)` exposes `piProvider`, built with `createProvider({ id, name: id, auth: { apiKey: { name: id, resolve } }, models: config.models.map(toPiModel), api: { "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi(), "anthropic-messages": anthropicMessagesApi() } })`, using the `*.lazy` imports.
   - Private `baseUrlFor(api)` builds `https://<res>.services.ai.azure.com/{openai/v1|anthropic}` and throws on any other `api`.
   - Private `toPiModel(model)` builds `Model<Api>`: `provider: id`, `baseUrl` from `baseUrlFor`, zero cost, input `["text"]`, limits from the config.
   - Private `resolveAuth()` returns `{ auth: { headers: { Authorization: \`Bearer ${token}\` } } }`.
   - Injecting `CredentialProvider` is the test seam: tests use a fake token without contacting Entra.
9. **`stream-adapter.ts`.**
    - `PiAiStreamAdapter(model)` with `toPiContext(request)` and `toLLMEvent(event)`; today's helpers become private methods.
    - Tools map as `request.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }))`.
    - Confirm, and test, that a `resolve()` failure (bad secret, MI unavailable) arrives as a pi-ai `error` event and becomes exactly one Lena `error` event, never a throw.
10. **`index.ts`.** `class PiAiLLM implements LLM`:
    - The constructor calls `createModels()` and, for each provider, `switch (kind)` → `setProvider(new PiAiFoundryProvider(id, config, credentialProviderFor(config.auth)).piProvider)`, ending in an exhaustive `never` check.
    - `listModels()` delegates to the store.
    - `stream(request)`:
      1. `store.findModel(request.model)`;
      2. throw if `request.tools?.length` and the model has `tools: false`;
      3. `models.getModel(provider, id)`;
      4. `new PiAiStreamAdapter(model)`;
      5. `models.streamSimple(model, adapter.toPiContext(request), { signal, temperature, maxTokens })`;
      6. map events with `adapter.toLLMEvent`.
    - No `createLLM`: callers write `new PiAiLLM(await SqlModelConfigStore.load(database))`.
11. **Unit tests (vitest, beside the code).** The database is a real in-memory SQLite (`openDatabase({ mode: "LOCAL", connection: ":memory:" })`); only `fetch` and the credential source are faked.
    - **`model-config-store.test.ts`:** a `saveProvider` → `load` round trip; `saveProvider` rejects an unknown `kind`/`api`, missing `contextWindow`/`tools`, an invalid auth union, an `apiKey` auth kind and a duplicate model id, writing nothing; re-saving a provider replaces its models; `load` rejects a hand-inserted invalid row; `findModel` throws on an unknown provider or model; `listModels` fields.
    - **`foundry-provider.test.ts`:** a fake `CredentialProvider` and a fake `fetch` (`ProviderRequestOptions.fetch`) assert the URL (one per protocol, from `baseUrlFor`) and header per request:

      | openai-responses | openai-completions | anthropic-messages |
      |---|---|---|
      | `Authorization: Bearer jwt` | `Authorization: Bearer jwt` | `Authorization: Bearer jwt`, and no `x-api-key` |

      It also checks that a `CredentialProvider` that rejects (bad secret, MI unavailable) yields exactly one Lena `error` event through `PiAiStreamAdapter`, never a throw.
    - **`stream-adapter.test.ts`:** `toPiContext` turns a real `Tool` into only `name`, `description` and `parameters`.
    - **`llm.test.ts`:** `listModels` returns the stored models; an unknown model throws; a tools request to a `tools: false` model throws. These fail before any token is fetched, so no Entra fake is needed.
12. **Live test (`test/live.test.ts`, skips without env).**
    - Seeds an in-memory SQLite through `saveProvider` from env, then builds `PiAiLLM` from `SqlModelConfigStore.load`.
    - Keeps its shape: `Tool` objects with `execute`, passed as `tools: [tool]`, results from `tool.execute(...)`.
    - Run {GPT via Responses, DeepSeek via Completions, Claude via Messages} with a service principal against one Foundry resource.
    - Each case asserts a text reply and one tool-call round trip. The DeepSeek case also asserts `thinking` events; if they are missing, add an optional `compat` to the model schema then.
    - Managed identity, system- and user-assigned, is run once from an Azure-hosted environment.
13. **Typecheck and test:** `pnpm --filter @lena/tool test`, `pnpm --filter @lena/datastore test`, `pnpm --filter @lena/llm typecheck && pnpm --filter @lena/llm test`, plus `pnpm --filter @lena/util --filter @lena/datastore --filter @lena/tool --filter @lena/llm typecheck`. A workspace-wide `pnpm -r typecheck` stays red until the agent loop restores session, recce and gateway-agent.

## Out of scope (noted gaps)

- **Next: the agent loop, built from scratch** (`docs/plan/agent-loop.md`). It replaces the archived agent, uses `LLM` from `@lena/llm` and passes `model` per request, and brings `@lena/session`, `@lena/recce` and `apps/gateway-agent` back to green; they lose `@lena/agent` in step 1.
- **Moving `@lena/session` onto `@lena/datastore`.** Its two stores collapse into one over `Database`; a plan of its own.
- **`Database.transaction`, a migration runner, and a backend flag.** Without a transaction, a database error partway through `saveProvider` can leave a provider with only some of its models. Validation runs before any write, so only a failure inside the database can cause this. Add `transaction` when that matters or when session moves over.
- **Wiring the app:** opening the one `Database` from `MODE` and the connection string at startup, and passing it to every store.
- **The frontend and API that call `saveProvider`**, and removing a whole provider.
- **First run with an empty database.** No provider means no model; the frontend's first-run step, or an env seed, fills it.
- **Hot reload.** Callers rebuild `PiAiLLM` after a save. If a live swap is ever needed, dsh's snapshot-per-config pattern (`adapter.ts current()`) is the reference.
- **Reasoning-effort selection, and image input** beyond what `ToolContent` replays.
- **`Toolbox.list(): Tool[]`.** The loop holds a `Toolbox`, which can't list its tools today; add `list()` when the loop moves onto `@lena/llm`.

## Verification

- Steps 11–13 above.
- The plan is done when:
  - all unit tests pass, including `@lena/datastore`'s;
  - the live matrix passes with a service principal;
  - `@lena/util`, `@lena/datastore`, `@lena/tool` and `@lena/llm` typecheck green.

## Sources

- [Foundry endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)
- [Entra ID keyless auth](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id)
- [Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- dsh reference: `deepseek-harness/packages/llm/llm-pi-ai/src/{provider,adapter,config}.ts`
