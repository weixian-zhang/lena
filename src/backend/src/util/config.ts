// Central home for token limits and the estimation ratios behind them. Kept in one
// file so the context budget can be reasoned about — and retuned for a new model
// deployment — without hunting through call sites.

/** Character-to-token ratio for prose. */
export const CHARS_PER_TOKEN = 4;

/** Ratio for JSON payloads (tool call arguments) — punctuation-dense, so denser in tokens. */
export const JSON_CHARS_PER_TOKEN = 3;

/** Per-message allowance for the role/delimiter framing the provider adds. 
 * Every message gets wrapped in role markers and delimiters when serialized — in OpenAI's format roughly <|im_start|>{role}\n{content}<|im_end|>\n. Those special tokens cost tokens even for an empty message.
*/
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Flat estimate per image, covering up to ~4K resolution. */
export const IMAGE_TOKENS = 3_000;

/** Flat estimate per PDF (~100 pages at 258 tokens/page). */
export const PDF_TOKENS = 25_800;

/** Max chars kept from a single tool result before it is truncated. */
export const TOOL_RESULT_TRUNCATE_CHARS = 2_000;

/** Recent transcript kept verbatim through a compaction, as `[head] [summary] [tail]`. */
export const COMPACTION_TAIL_TOKENS = 20_000;

/**
 * Fallback context window, used only when the deployment can't be resolved against
 * models.dev. Deliberately conservative: over-estimating the window skips compaction
 * and the request then hard-fails mid-operation.
 */
export const CONTEXT_WINDOW_TOKENS = 200_000;

/** Max output tokens per turn — sized for a compaction summary, the longest generation. */
export const MAX_OUTPUT_TOKENS = 32_768;

/**
 * Slice of the window held back from the transcript:
 * `CONTEXT_WINDOW_TOKENS - CONTEXT_HEAD_ROOM_TOKEN` is what's usable for the system
 * prompt, user prompt, tool schemas, skills, and the rest of the assembled request.
 *
 * Sized as {@link MAX_OUTPUT_TOKENS} (the model's reply shares the window) plus slack,
 * because the estimator measures messages only — tool schemas and per-request framing
 * ride along uncounted. Erring large just compacts sooner; erring small overflows the
 * request mid-operation.
 */
export const CONTEXT_HEAD_ROOM_TOKEN = 16_384;

/** Public model catalogue we resolve the deployment's context window against. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Re-download the catalogue once the cached copy's mtime is older than this. */
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Give up on the download rather than stalling startup; a stale cache still serves. */
export const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;

/**
 * Providers searched for the deployment name, in order. Order matters: a dozen providers
 * list the same model ids with different windows (e.g. `gpt-5.6-sol` is 1.05M under
 * `azure` but 372K under `xpersona`), so Azure's numbers win. Anthropic isn't searched —
 * Foundry serves the Claude models under `azure`, with its own limits.
 */
export const MODELS_DEV_PROVIDERS = ["azure", "azure-cognitive-services", "openai"] as const;
