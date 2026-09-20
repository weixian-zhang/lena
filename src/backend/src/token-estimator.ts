// Local token estimation. No tokenizer dependency: Lena's model is a Foundry
// deployment name over an OpenAI-compatible endpoint, so the BPE vocabulary is
// unknowable and any real tokenizer would be confidently wrong.

import type { AgentContentBlock, AgentMessage } from "./agent/types.js";
import {
  CHARS_PER_TOKEN,
  IMAGE_TOKENS,
  JSON_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  PDF_TOKENS,
} from "./util/config.js";

/**
 * Estimate tokens for a text string from its character count.
 *
 * Rounds up so a non-empty string never estimates to zero, and because
 * under-counting is the dangerous direction for a context budget — it skips
 * compaction and the request then hard-fails mid-operation.
 *
 * @param text - The string to measure.
 * @param charsPerToken - Characters per token. Defaults to
 *   {@link CHARS_PER_TOKEN}; lower it (~3) for JSON-heavy payloads.
 */
export function estimateTextTokens(
  text: string,
  charsPerToken: number = CHARS_PER_TOKEN,
): number {
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate tokens for a media attachment from its MIME type.
 *
 * Media cost is driven by the provider's tiling, not by payload size, so a flat
 * per-kind constant beats measuring the base64 bytes. Returns 0 for unknown
 * kinds, letting the caller fall back to a text estimate.
 *
 * @param mimeType - e.g. `image/png`, `application/pdf`.
 */
export function estimateMediaTokens(mimeType: string): number {
  if (mimeType.startsWith("image/")) return IMAGE_TOKENS;
  if (mimeType.startsWith("application/pdf")) return PDF_TOKENS;
  return 0;
}

/**
 * Estimate tokens for one transcript message, across every content block kind
 * the model actually receives.
 *
 * `toolResult.details` is skipped on purpose — it's local metadata for logs and
 * the UI, never serialized into the request.
 */
export function estimateTokens(
  message: AgentMessage,
  charsPerToken: number = CHARS_PER_TOKEN,
): number {
  const content = message.content;

  if (typeof content === "string") {
    return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(content, charsPerToken);
  }

  let tokens = MESSAGE_OVERHEAD_TOKENS;

  for (const block of content as readonly AgentContentBlock[]) {
    switch (block.type) {
      case "text":
        tokens += estimateTextTokens(block.text, charsPerToken);
        break;
      case "thinking":
        // Billed as output on the turn that produced it, and replayed as input after.
        tokens += estimateTextTokens(block.thinking, charsPerToken);
        break;
      case "toolCall":
        tokens +=
          estimateTextTokens(block.name, charsPerToken) +
          estimateTextTokens(JSON.stringify(block.arguments ?? {}), JSON_CHARS_PER_TOKEN);
        break;
      case "image": {
        // Fall back to the base64 payload only for MIME types the flat table misses.
        const media = estimateMediaTokens(block.mimeType);
        tokens += media || estimateTextTokens(block.data, charsPerToken);
        break;
      }
    }
  }

  return tokens;
}
