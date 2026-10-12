# LLM package: Foundry only, through the OpenAI SDK

## Context

Lena needs an LLM module that streams one model call at a time, with tools and thinking, for the agent loop.

**What changed in this revision:**
- **pi-ai is dropped.** Lena will only ever call Microsoft Foundry, so a multi-provider router adds a layer without a use. Lena calls Foundry's v1 endpoint with the plain **OpenAI SDK** (`openai` ^6), so users can pick any deployment Foundry serves there.
- **No Foundry SDK.** `@azure/ai-projects` adds agents, evaluations and Foundry tools Lena doesn't use; for model calls its `getOpenAIClient()` only builds the same `OpenAI` client against a project URL. Using `openai` directly drops a package and the need for a Foundry project.
- **The config store is removed.** A separate config module, still to be built, stores global configuration, including the model and the authentication method. `@lena/llm` stores nothing; the caller passes what it needs.

**v1 scope:**
- **Provider:** Microsoft Foundry only, through the resource's `/openai/v1` endpoint.
- **Auth:** Entra ID only, three kinds: service principal, system-assigned managed identity and user-assigned managed identity. No API keys.
- **Protocol:** the Responses API only. One protocol means one adapter and no per-model `api` field.

**The old agent is archived** at `packages/archive/agent`, outside the pnpm workspace. After this module, the agent loop is built from scratch on `@lena/llm` (`docs/plan/agent-loop.md`).

## Research: Foundry's endpoints and the OpenAI SDK

From Microsoft's [SDK overview](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/sdk-overview) (updated 2026-10-07) and the [v1 API doc](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle):

| SDK | Endpoint | Serves |
|---|---|---|
| **OpenAI SDK** (`openai` ^6): **the one Lena uses** | `https://<res>.services.ai.azure.com/openai/v1` (or `<res>.openai.azure.com/openai/v1`) | Responses for Azure OpenAI models and Foundry Models sold by Azure (MAI, DeepSeek, Grok); Chat Completions for other models sold by Azure |
| Foundry SDK (`@azure/ai-projects` 2.8.0) | `https://<res>.services.ai.azure.com/api/projects/<project>` | The same Responses API through a project, plus agents, evaluations and Foundry tools. Not needed. |
| Anthropic SDK | `https://<res>.services.ai.azure.com/anthropic` | Claude only: "Claude models use a separate `/anthropic` endpoint and the Anthropic Messages API, not the OpenAI-compatible endpoint." |

- **One client serves every deployment.** The endpoint is per resource, and the deployment is the per-request `model` field, so swapping deployments needs no new client or endpoint.
- **Auth.** Microsoft's JavaScript sample for the v1 API:
  ```ts
  new OpenAI({
    baseURL: "https://<res>.services.ai.azure.com/openai/v1",
    apiKey: getBearerTokenProvider(credential, "https://ai.azure.com/.default"),
  });
  ```
  The token provider runs on every request and `@azure/identity` caches and refreshes the token, so Lena passes in only a `TokenCredential`. The identity needs **Cognitive Services OpenAI User** on the resource.
- **Request `model`:** the deployment name.
- **Thinking.** The `openai` SDK's `ReasoningEffort` is `none | minimal | low | medium | high | xhigh | max`, which already matches `LLM_THINKING_LEVELS`. Visible thinking needs `reasoning: { summary: "auto" }`.
- **Claude is not reachable this way.** It needs the Anthropic SDK on `/anthropic`. See *Open questions*.

## Decisions

1. **One SDK: `openai`.** `FoundryLLM` builds one `OpenAI` client in its constructor and reuses it for every request.
2. **Responses API only.** It's the protocol Microsoft recommends on the v1 endpoint.
   - `stream()` calls `openai.responses.create({ …, stream: true })`.
   - `store: false`: every request carries the full conversation, so nothing is kept server-side.
3. **The caller passes config as data; `@lena/llm` stores nothing.**
   - `FoundryLLM` takes `{ foundryName, credential, model }`.
   - The future config module reads the model and auth method from global configuration. It turns the auth method into a credential with `createTokenCredential(auth)`, which `@lena/llm` exports.
   - Validating the stored config is the config module's job. `FoundryLLM` throws only on an empty `foundryName` or `model`.
4. **Auth is Entra ID only, as a `TokenCredential`.**
   - `createTokenCredential(auth)` switches on three explicit kinds, ending in an exhaustive `never` check:

     | `AuthConfig` | Credential |
     |---|---|
     | `{ kind: "servicePrincipal", tenantId, clientId, clientSecretEnv }` | `ClientSecretCredential(tenantId, clientId, process.env[clientSecretEnv])`; throws if the env var is unset |
     | `{ kind: "systemAssignedManagedIdentity" }` | `ManagedIdentityCredential()` |
     | `{ kind: "userAssignedManagedIdentity", clientId }` | `ManagedIdentityCredential({ clientId })` |

   - System- and user-assigned are separate kinds, not one kind with an optional `clientId`: a missing `clientId` would otherwise switch silently to the system-assigned identity.
   - There's no `DefaultAzureCredential` chain and no API keys.
   - `FoundryLLM` turns the credential into the client's `apiKey` with `createFoundryTokenProvider(credential)` from `credential.ts`, which keeps `FOUNDRY_SCOPE` private.
   - Taking a credential, not an auth config, is also the test seam: the unit test passes a fake credential and contacts no Entra.
5. **One model per `FoundryLLM`.** The caller picks the deployment. Switching models means building another `FoundryLLM`; keep one per session and model.
6. **Model limits and capabilities live with the caller.** `@lena/llm` keeps no `contextWindow`, `maxTokens` or `reasoning` per model.
   - Per request, `maxTokens` and `thinkingLevel` are passed straight through.
   - A deployment that rejects them fails loudly with Foundry's own `400`, which arrives as an `error` event.
7. **Tools are `@lena/tool`'s `Tool`** (type import from `@lena/tool/tool`).
   - Each tool is sent as `{ type: "function", name, description, parameters, strict: false }`.
   - `execute` never leaves the process.
8. **The event contract stays** (`LLMEvent`: `thinking`, `tool_call`, `done`, `error`), so the agent loop plan is unaffected.
   - Every stream ends in exactly one `done` or `error`.
   - SDK and HTTP failures, auth included, become an `error` event and are never thrown out of `stream()`.

## Package design: `packages/llm` (`@lena/llm`)

```
packages/llm/
  package.json           @lena/llm, deps: openai ^6, @azure/identity ^4.13.1, @lena/tool
  tsconfig.json
  index.ts               LLM, FoundryLLM, re-exports
  types.ts               data types only
  credential.ts          AuthConfig, createTokenCredential, createFoundryTokenProvider
  responses-adapter.ts   ResponsesAdapter / FoundryResponsesAdapter
  test/
    llm.test.ts
```

| Interface | Class | Role |
|---|---|---|
| `LLM` | `FoundryLLM` | built for one Foundry resource and model deployment; streams requests on it |
| `ResponsesAdapter` | `FoundryResponsesAdapter` | Lena request → Responses request; Responses stream events → `LLMEvent`, for one call |

Pure data stays `type`: `LLMRequest`, `LLMEvent`, `LLMMessage`, `LLMToolCall`, `LLMUsage`, `LLMStopReason`,
`LLMThinkingLevel`, `AuthConfig`, `FoundryLLMConfig`.

**Public surface:**

```ts
interface LLM {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent, void>;
}
type FoundryLLMConfig = { foundryName: string; credential: TokenCredential; model: string };  // resource name, e.g. "lena-prod"
class FoundryLLM implements LLM { constructor(config: FoundryLLMConfig) }
function createTokenCredential(auth: AuthConfig): TokenCredential;

// usage, by the future config module or the agent loop:
const llm = new FoundryLLM({
  foundryName: "lena-prod", // → https://lena-prod.services.ai.azure.com/openai/v1
  credential: createTokenCredential({ kind: "systemAssignedManagedIdentity" }),
  model: "gpt-5.5",
});
llm.stream({ systemPrompt, messages, tools, thinkingLevel: "high", signal });
```

**Mapping (`FoundryResponsesAdapter`):**

| Lena | Responses API |
|---|---|
| `systemPrompt` | `instructions` |
| `user` message | `{ role: "user", content }` |
| `assistant` message | `{ role: "assistant", content }`, plus one `{ type: "function_call", call_id, name, arguments }` per tool call |
| `toolResult` message | `{ type: "function_call_output", call_id, output }`; `ToolContent[]` becomes `input_text`/`input_image` items |
| `thinkingLevel` | `reasoning: { effort, summary: "auto" }` |
| `maxTokens`, `temperature`, `signal` | `max_output_tokens`, `temperature`, the request's `signal` |
| `response.reasoning_summary_text.delta`, `response.reasoning_text.delta` | `thinking`, and accumulated into `done.thinking` (parts separated by a blank line) |
| `response.output_text.delta` | accumulated into `done.text` |
| `response.output_item.done` with a `function_call` item | `tool_call` (arguments parsed from JSON) |
| `response.completed` | `done`: `toolUse` if there were tool calls, else `stop`; usage from `input_tokens`/`output_tokens`/`total_tokens` |
| `response.incomplete` (max output tokens) | `done` with `outputLengthExceeded` |
| `response.failed`, `error`, a thrown `APIError` | `error`; an aborted signal gives reason `aborted` |

Following Lena's CLAUDE.md: exported items first, an interface plus a class that `implements` it, comments 1–3 lines.

## Step-by-step implementation

1. **Detach the workspace from the archived agent.** ✅ *Done.* `packages/agent` → `packages/archive/agent`; the `@lena/agent` dependency lines are removed. `@lena/session`, `@lena/recce` and `apps/gateway-agent` stay red until the agent loop rebuilds them.
2. **Build `@lena/datastore`.** ✅ *Done* (commit `06b5dc9`). `@lena/llm` no longer depends on it; it stays for the config module and the session store.
3. **Scaffold `packages/llm`.** ✅ *Done.*
4. **Move the archived `llm/` into `packages/llm`.** ✅ *Done*, then evolved on pi-ai (`PiAiLLM`, `stream-adapter.ts`, one end-to-end test). Steps 6–11 replace that pi-ai code.
5. **Remove the model config store.** ✅ *Done.* `model-config-store.ts` and its export are deleted, and so is the `@lena/datastore` dependency. The future config module owns storage.
6. **Swap dependencies.** ✅ *Done.* Removed `@earendil-works/pi-ai` and `typebox`; added `openai` ^6.49.0. Deleted `provider-config.ts` and `stream-adapter.ts`.
7. **`types.ts`.** ✅ *Done.* Drop `LLM_APIS`/`LLMApi`. `LLM_THINKING_LEVELS` stays as is, since it matches the SDK's `ReasoningEffort` except `none` (omit `thinkingLevel` instead). Everything else is unchanged.
8. **`credential.ts`.** ✅ *Done.* `AuthConfig` (the three kinds in decision 4), `FOUNDRY_SCOPE` and `createTokenCredential(auth)`. `CredentialProvider` and `EntraCredentialProvider` go: `createFoundryTokenProvider(credential)` wraps `getBearerTokenProvider` with the Foundry scope and is passed to the client as `apiKey`.
9. **`responses-adapter.ts`.** ✅ *Done.* `FoundryResponsesAdapter`, one per call:
   - `createResponseParam(llmRequest, model)` builds the `responses.create` body from the mapping above.
   - `toLLMEvent(event)` translates one stream event, keeping the text, thinking and tool calls seen so far for `done`.
   - Beyond the mapping table:
     - `ToolContent[]` results are sent as `input_text`/`input_image` items, not joined to text, so images reach the model.
     - `response.incomplete` is `done`/`outputLengthExceeded` only for `max_output_tokens`; any other reason (a content filter) is an `error`.
     - Tool arguments that aren't a JSON object, and a completed response without usage, throw; `FoundryLLM` turns the throw into an `error` event.
     - Tool schemas are cast to `Record<string, unknown>`: a typebox schema is plain JSON Schema, and the SDK's type only lacks the index signature.
     - `toolResult.isError` isn't sent: the Responses API has no such field, so the error has to be in the result text.
10. **`index.ts`: `FoundryLLM`.** ✅ *Done.*
    - The constructor throws on an empty `foundryName` or `model`, then builds the `OpenAI` client once: `baseURL` is `https://<foundryName>.services.ai.azure.com/openai/v1`, `apiKey` is `createFoundryTokenProvider(credential)`.
    - `stream()` calls `responses.create({ ...adapter.createResponseParam(request, model), stream: true, store: false }, { signal })` and yields translated events. It catches SDK errors and yields one `error` event (`aborted` if the signal fired). It stops after the first `done` or `error`, and yields an `error` if the stream ends without one.
11. **Unit test (one, end to end).** ✅ *Done: passes; `@lena/llm` typechecks.* A fake `TokenCredential` returns `jwt-123`. A stubbed global `fetch` returns a canned Responses SSE stream with a reasoning summary delta, a text delta and `response.completed`. The test checks:
    - the events are `thinking`, then `done` with text and usage;
    - the request went to `https://<res>.services.ai.azure.com/openai/v1/responses` with `Authorization: Bearer jwt-123`.

    A one-off capture confirmed the body: `{ model, input, reasoning: { effort: "high", summary: "auto" }, store: false, stream: true }`.
12. **Live test (skips without env).** Service principal against one Foundry resource, each case a text reply plus one tool-call round trip:
    - GPT-5.x, with `thinking` events at `thinkingLevel: "high"`;
    - DeepSeek;
    - Grok.

    Also confirm that **Cognitive Services OpenAI User** on the resource is the only role needed, and that a Claude deployment fails cleanly with an `error` event. Run system-assigned and user-assigned managed identity once each from an Azure-hosted environment (for example, a Container App with both identities attached), since neither works off Azure.
13. **Typecheck and test:** `pnpm --filter @lena/tool --filter @lena/datastore --filter @lena/llm typecheck` and `pnpm --filter @lena/llm test`.

## Open questions

- **Claude.** "Any model on Foundry" excludes Claude on this path. Supporting it means a second adapter on the Anthropic SDK and `/anthropic`, picked by a per-model protocol field. Decide before step 12 whether Claude is in v1.
- **Models without Responses support.** Some catalog models (earlier checks: Mistral, Kimi, Cohere) answered `400 Model not supported` on Responses and only work on Chat Completions. The live test settles which ones Lena needs. A Chat Completions path would be a second adapter on the same `OpenAI` client.

## Out of scope (noted gaps)

- **The config module**: storing the model and auth method, validating them, and building `FoundryLLM`.
- **Carrying reasoning across tool calls.** With `store: false`, OpenAI reasoning models drop their reasoning between turns. Replaying it needs `include: ["reasoning.encrypted_content"]` and reasoning items in `LLMMessage`; add it if tool-heavy turns degrade.
- **Image input in user messages.** Images reach the model only inside tool results today.
- **Foundry SDK features** (agents, evaluations, Foundry tools such as file search, code interpreter, web search, MCP). Lena runs its own tools.
- **`Toolbox.list(): Tool[]`**, needed when the loop moves onto `@lena/llm`.

## Verification

- Steps 11–13.
- Done when the unit test passes, the live matrix passes with a service principal, and `@lena/tool`, `@lena/datastore` and `@lena/llm` typecheck.

## Sources

- [Foundry v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Foundry SDKs and endpoints](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/sdk-overview)
- [Entra ID keyless auth](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id)
- [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- `openai@6.49.0` `resources/shared.d.ts` (`ReasoningEffort`)
