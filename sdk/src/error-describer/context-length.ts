/**
 * A provider refusing a request that does not fit the model's context window
 * ("prompt is too long", `context_length_exceeded`, …).
 *
 * The backend's stream classifiers recognize the same refusals and answer
 * them with the code `context_length_exceeded` and
 * {@link CONTEXT_LENGTH_EXCEEDED_MESSAGE}. This rule covers what reaches the
 * describer without that code: the direct engine's provider errors, and eval
 * and swarm cards, which keep only the message. Both repos test against
 * `tests/fixtures/context-length-parity-fixtures.json`, pinned in the
 * backend's `convex/lib/mirrors.json`.
 */

/** The backend's sentence for this refusal, verbatim. */
export const CONTEXT_LENGTH_EXCEEDED_MESSAGE =
  "This chat is too long for the model's context window. Reset the chat, have the tool return less, or choose a model with a larger context window.";

/** The backend's sentence, as eval and swarm cards receive it. */
const BACKEND_SENTENCE =
  /this chat is too long for the model's context window/i;

/**
 * Each provider's wording. An MCP server can use the same words about its own
 * limits, so they count only on a provider-shaped error.
 */
const PROVIDER_PATTERNS: readonly RegExp[] = [
  // OpenAI, Azure OpenAI and OpenRouter send it as a structured code.
  /context_length_exceeded/,
  // Anthropic, directly or through Bedrock and Vertex.
  /prompt is too long/i,
  // Amazon Bedrock.
  /input is too long for requested model/i,
  // OpenAI Chat Completions and OpenRouter's own check.
  /maximum context length is \d[\d,]* tokens/i,
  // OpenAI Responses.
  /exceeds the context window/i,
  // Google Gemini.
  /input token count \(\d+\) exceeds the maximum number of tokens allowed/i,
];

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

/**
 * The text without OpenRouter's `metadata.previous_errors`, which lists the
 * earlier providers' failures: an earlier attempt must not label, or give its
 * numbers to, a different final error. Text that is not JSON is read as it is.
 */
function currentErrorText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), (key, value: unknown) =>
      key === "previous_errors" ? undefined : value
    );
  } catch {
    // Not JSON (an HTML page, a provider's plain sentence): nothing to leave out.
    return text;
  }
}

const toNumber = (digits: string) => Number(digits.replace(/,/g, ""));

/**
 * The token counts a provider's refusal states (a body or a sentence), or
 * `null` when it states none.
 */
export function contextLengthCounts(
  text: string
): { used: number; limit: number } | null {
  const current = currentErrorText(text);
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
 * Whether the error is this refusal. Every documented refusal is a 400, so an
 * error that states another status is never one. The backend's own sentence
 * and code count on any error; a provider's wording only on a provider-shaped
 * one (a stated 400 or a response body) without a numeric code, because a
 * JSON-RPC or transport error is the user's MCP server talking.
 */
export function isContextLengthExceeded(
  error: unknown,
  message: string,
  status: number | undefined
): boolean {
  if (status !== undefined && status !== 400) return false;
  const record =
    error && typeof error === "object"
      ? (error as { message?: unknown; code?: unknown; responseBody?: unknown })
      : undefined;
  if (record?.code === "context_length_exceeded") return true;
  // A plain record's serialized form carries its body, history included:
  // read its own message instead.
  const ownMessage =
    typeof record?.message === "string" ? record.message : message;
  if (BACKEND_SENTENCE.test(ownMessage)) return true;
  if (typeof record?.code === "number") return false;
  const rawBody = record?.responseBody;
  const hasBody = typeof rawBody === "string";
  if (!hasBody && status !== 400) return false;
  const body = hasBody ? currentErrorText(rawBody) : "";
  return PROVIDER_PATTERNS.some(
    (pattern) => pattern.test(ownMessage) || pattern.test(body)
  );
}
