import { describeAsSlug, type NormalizedError } from "@mcpjam/sdk/browser";

/**
 * Backend code for a provider refusing a chat too long for the model's
 * context window (convex `lib/contextLengthError.ts`). Sent by `/stream` and
 * `/stream/org` with status 400, `isRetryable: false` and the provider's body
 * as `details`. The direct engine answers the same refusal with the same code.
 */
export const CONTEXT_LENGTH_EXCEEDED_CODE = "context_length_exceeded";

export function isContextLengthExceededCode(
  code: string | null | undefined,
): boolean {
  return code === CONTEXT_LENGTH_EXCEEDED_CODE;
}

/**
 * The providers whose sentence states both numbers. The first group is what
 * the chat used and the second the model's limit, except where `limitFirst`.
 */
const COUNT_PATTERNS: ReadonlyArray<{ pattern: RegExp; limitFirst: boolean }> =
  [
    // Anthropic: "prompt is too long: 596303 tokens > 200000 maximum", where
    // "maximum" is sometimes missing.
    {
      pattern: /prompt is too long: (\d[\d,]*) tokens > (\d[\d,]*)/i,
      limitFirst: false,
    },
    // OpenAI Chat Completions and OpenRouter's own check.
    {
      pattern:
        /maximum context length is (\d[\d,]*) tokens\. However, (?:your messages resulted in|you requested(?: about)?) (\d[\d,]*) tokens/i,
      limitFirst: true,
    },
    // Google Gemini.
    {
      pattern:
        /input token count \((\d[\d,]*)\) exceeds the maximum number of tokens allowed \((\d[\d,]*)\)/i,
      limitFirst: false,
    },
  ];

const toNumber = (digits: string) => Number(digits.replace(/,/g, ""));

/** The token counts the provider stated, or `null` when it stated none. */
export function contextLengthCounts(
  text: string,
): { used: number; limit: number } | null {
  // Counts come from the current error, never OpenRouter's previous attempts.
  let current = text;
  try {
    current = JSON.stringify(JSON.parse(text), (key, value: unknown) =>
      key === "previous_errors" ? undefined : value,
    );
  } catch {
    // Not JSON: a provider's plain sentence, read as it is.
  }
  for (const { pattern, limitFirst } of COUNT_PATTERNS) {
    const match = pattern.exec(current);
    if (!match) continue;
    const first = toNumber(match[1]);
    const second = toNumber(match[2]);
    return limitFirst
      ? { used: second, limit: first }
      : { used: first, limit: second };
  }
  return null;
}

/**
 * The catalog entry for this refusal, with the counts in its one line when
 * the provider's body (`details`) states them.
 */
export function describeContextLengthExceeded(
  details: string | null | undefined,
): NormalizedError {
  const base = describeAsSlug("provider/context_length_exceeded");
  const counts = details ? contextLengthCounts(details) : null;
  if (!counts) return base;
  return {
    ...base,
    oneLine: `This chat has ${counts.used.toLocaleString("en-US")} tokens, and the model accepts up to ${counts.limit.toLocaleString("en-US")}.`,
  };
}
