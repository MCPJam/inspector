/**
 * Turning a swarm attempt's raw failure into something a developer can act on.
 *
 * `journeyRunAttempts.errorMessage` is specified as "a capped +
 * credential-redacted human string. Never a raw provider payload" — but the
 * runner was storing the thrown `SwarmAgentError.message` verbatim, which looks
 * like this:
 *
 *   swarm-agent https://<deployment>.convex.site/journey-execution/
 *   persona-next-turn failed (429): {"ok":false,"code":"user_rate_limit",
 *   "error":"Daily MCPJam model limit reached. Use BYOK or try again
 *   tomorrow.","retryAfter":9259503,"details":"Try again in 155 minutes."}
 *
 * Everything a user needs is in there, and none of it is readable. Worse, the
 * URL embeds the deployment name, which is exactly the kind of internal detail
 * the field contract exists to keep out.
 *
 * This module is the ONE implementation, shared by both sides:
 *  - the runner calls it BEFORE reporting, so stored rows are clean going
 *    forward (sanitize at the producer);
 *  - the UI calls it when RENDERING, so rows already written in the old format
 *    still read well without a backfill.
 *
 * Idempotent by construction: an already-clean string parses to itself.
 */

/** Matches the `SwarmAgentError` message envelope the runner throws. */
const AGENT_ERROR_ENVELOPE = /^swarm-agent\s+\S+\s+failed\s+\((\d{3})\):\s*/i;

/** Belt-and-braces: never let a URL reach a stored/rendered message. */
const URL_PATTERN = /https?:\/\/\S+/g;

export const MAX_ATTEMPT_ERROR_CHARS = 500;

export type SwarmAttemptErrorInfo = {
  /** Clean, user-facing sentence. Always non-empty. */
  message: string;
  /** Machine tag from the provider envelope, when it carried one. */
  code?: string;
  /** Milliseconds until the limit resets, when known. */
  retryAfterMs?: number;
  /** The user can lift this themselves by purchasing credit. */
  canTopUp?: boolean;
  /** HTTP status from the failing call, when the envelope carried one. */
  httpStatus?: number;
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function scrub(text: string): string {
  return text.replace(URL_PATTERN, "").replace(/\s+/g, " ").trim();
}

/**
 * Compose the sentence. `error` is the headline ("Daily MCPJam model limit
 * reached…"); `details` is the actionable remainder ("Try again in 155
 * minutes."). Joined only when `details` adds something the headline doesn't
 * already say, so we never emit "…try again tomorrow. Try again in 155
 * minutes." as one breath.
 */
function compose(headline: string, details?: string): string {
  if (!details) return headline;
  if (headline.toLowerCase().includes(details.toLowerCase())) return headline;
  const separator = /[.!?]$/.test(headline) ? " " : ". ";
  return `${headline}${separator}${details}`;
}

/**
 * Extract a clean message + structured hints from whatever the runner caught.
 *
 * Never throws and never returns an empty message — an unparseable input is
 * scrubbed and passed through, because a slightly ugly real error beats a
 * confident "Unknown error".
 */
export function humanizeSwarmAttemptError(
  raw: string | undefined | null
): SwarmAttemptErrorInfo {
  const input = (raw ?? "").trim();
  if (!input) return { message: "The session failed for an unknown reason." };

  let body = input;
  let httpStatus: number | undefined;

  const envelope = AGENT_ERROR_ENVELOPE.exec(input);
  if (envelope) {
    httpStatus = Number(envelope[1]);
    body = input.slice(envelope[0].length).trim();
  }

  const parsed = parseJsonObject(body);
  if (!parsed) {
    const cleaned = scrub(body) || scrub(input);
    return {
      message: (cleaned || "The session failed for an unknown reason.").slice(
        0,
        MAX_ATTEMPT_ERROR_CHARS
      ),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }

  const headline =
    str(parsed.error) ?? str(parsed.message) ?? "The session could not run.";
  const details = str(parsed.details);
  const code = str(parsed.code);
  const retryAfterMs = num(parsed.retryAfter);
  const canTopUp = parsed.canTopUp === true;

  return {
    message: scrub(compose(headline, details)).slice(
      0,
      MAX_ATTEMPT_ERROR_CHARS
    ),
    ...(code ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(canTopUp ? { canTopUp } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

/** Convenience for the producer, which stores a string and nothing else. */
export function humanizeSwarmAttemptErrorMessage(
  raw: string | undefined | null
): string {
  return humanizeSwarmAttemptError(raw).message;
}
