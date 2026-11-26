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
  "This chat is too long for the model's context window. Start a new chat, have the tool return less, or pick a model with a larger context window.";

/** Each provider's wording, and the backend's own sentence. */
const CONTEXT_LENGTH_PATTERNS: readonly RegExp[] = [
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
  // The backend's sentence, as eval and swarm cards receive it.
  /this chat is too long for the model's context window/i,
];

/**
 * The body without OpenRouter's `metadata.previous_errors`, which lists the
 * earlier providers' failures: an earlier "prompt is too long" must not label
 * a different final error. A body that is not JSON is read as it is.
 */
function currentErrorText(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), (key, value: unknown) =>
      key === "previous_errors" ? undefined : value
    );
  } catch {
    // Not JSON (an HTML page, plain text): nothing to leave out.
    return body;
  }
}

/**
 * Whether `message`, or the error's `responseBody`, is this refusal. Every
 * documented refusal is a 400, so an error that states another status is
 * never one.
 */
export function isContextLengthExceeded(
  error: unknown,
  message: string,
  status: number | undefined
): boolean {
  if (status !== undefined && status !== 400) return false;
  const rawBody =
    error && typeof error === "object"
      ? (error as { responseBody?: unknown }).responseBody
      : undefined;
  const body = typeof rawBody === "string" ? currentErrorText(rawBody) : "";
  return CONTEXT_LENGTH_PATTERNS.some(
    (pattern) => pattern.test(message) || pattern.test(body)
  );
}
