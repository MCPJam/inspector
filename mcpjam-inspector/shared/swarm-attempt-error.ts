import { looksLikeErrorPage } from "./error-page.js";
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
import {
  isRerunnableXaaFailure,
  isXaaConnectFailureReason,
  XaaConnectFailureReason,
} from "./xaa-connect-failure.js";

/** Matches the `SwarmAgentError` message envelope the runner throws. */
const AGENT_ERROR_ENVELOPE = /^(?:swarm-agent\s+\S+\s+failed\s+\((\d{3})\):|Backend stream error:\s*(\d{3}))\s*/i;

/** Belt-and-braces: never let a URL reach a stored/rendered message. */
const URL_PATTERN = /https?:\/\/\S+/g;

export const SPEND_REFUSAL_REASONS = [
  "holds_committed",
  "wallet_locked",
  "budget_reached",
  "allowance_exhausted",
  "admission_invalid",
  "insufficient_for_request",
] as const;

export function isTransientSpendRefusal(
  code?: string,
  refusalReason?: string,
): boolean {
  return code === "user_rate_limit" && refusalReason === "holds_committed";
}

export const MAX_ATTEMPT_ERROR_CHARS = 500;

export type SwarmAttemptErrorInfo = {
  /** Clean, user-facing sentence. Always non-empty. */
  message: string;
  /**
   * The failure is a handshake to re-run, not a breakage to investigate (an
   * expired sign-in in front of an XAA-protected server). Surfaces use it to
   * pick a calm treatment: red is for what the user must go and fix.
   */
  rerunnable?: boolean;
  /** Machine tag from the provider envelope, when it carried one. */
  code?: string;
  /** Milliseconds until the limit resets, when known. */
  retryAfterMs?: number;
  /** The user can lift this themselves by purchasing credit. */
  canTopUp?: boolean;
  refusalReason?: string;
  isRetryable?: boolean;
  outstandingHolds?: number;
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
 * Cloud-sandbox failure codes (`journeyRunAttempts.errorCode`, written by the
 * runner's sandbox path) → user-facing sentences. Framed around "MCPJam
 * cloud" because the stored messages talk about data planes and control
 * planes — accurate for operators, opaque for the person whose swarm just
 * didn't run. Keyed by the exact literals the runner reports
 * (`swarm-runner.ts` / `swarm-sandbox.ts`).
 */
const SANDBOX_ERROR_CODE_MESSAGES: Record<string, string> = {
  sandbox_unavailable:
    "This session needed an MCPJam cloud sandbox for its computer commands, but this inspector can't run cloud sandboxes — the session could not execute commands.",
  sandbox_at_capacity:
    "MCPJam cloud is at capacity right now — try the run again in a few minutes.",
  sandbox_error:
    "The cloud sandbox for this session hit an error while starting — try the run again.",
};

/**
 * Connect-time XAA failure reasons (`journeyRunAttempts.errorCode`, written by
 * the runner from the thrown route error's `details.reason`) → the sentence to
 * show if the row somehow carries no message. The server already writes a
 * server-named, one-action sentence for these, so the stored message WINS —
 * these are the floor, not a replacement, and they exist because "The session
 * failed for an unknown reason" is the one thing a swarm must never say about
 * an authorization handshake it can name.
 */
const XAA_REASON_FALLBACK_MESSAGES: Record<XaaConnectFailureReason, string> = {
  [XaaConnectFailureReason.REAUTH_REQUIRED]:
    "Your sign-in expired before this server's enterprise access token could be issued — sign in again, then re-run.",
  [XaaConnectFailureReason.AUTHORIZATION_SERVER_UNKNOWN]:
    "MCPJam couldn't find the authorization server protecting this server — set its issuer in the server's auth settings.",
  [XaaConnectFailureReason.NOT_SUPPORTED_HERE]:
    "This server's enterprise authorization mode can't run on this deployment — use pre-registered credentials in the server's auth settings.",
  [XaaConnectFailureReason.AUTHORIZATION_REJECTED]:
    "The authorization server rejected MCPJam's access request — check the server's XAA client credentials and issuer in its auth settings.",
  [XaaConnectFailureReason.CONFIGURATION_INVALID]:
    "This server isn't fully configured for enterprise-managed authorization — finish its XAA settings, or set an explicit auth method.",
  [XaaConnectFailureReason.HANDSHAKE_FAILED]:
    "This server couldn't complete its enterprise authorization handshake — try again, and check its auth settings if it keeps failing.",
};

/**
 * Extract a clean message + structured hints from whatever the runner caught.
 *
 * Never throws and never returns an empty message — an unparseable input is
 * scrubbed and passed through, because a slightly ugly real error beats a
 * confident "Unknown error".
 *
 * `errorCode` is the attempt row's structured code, when the caller has one.
 * A recognized sandbox code wins over the stored message: those messages are
 * operator-framed ("not configured to provision disposable sandboxes"), and
 * the code says precisely what a user can act on.
 */
export function humanizeSwarmAttemptError(
  raw: string | undefined | null,
  errorCode?: string | null
): SwarmAttemptErrorInfo {
  if (errorCode === "stale_runner") {
    return {
      code: errorCode,
      message:
        "The runner stopped reporting progress, so this run was marked interrupted. Sessions may have run before the interruption; inspect their saved traces. The reason contact was lost was not recorded.",
    };
  }
  const sandboxMessage = errorCode
    ? SANDBOX_ERROR_CODE_MESSAGES[errorCode]
    : undefined;
  if (sandboxMessage && errorCode) {
    return { message: sandboxMessage, code: errorCode };
  }
  const input = (raw ?? "").trim();
  // Older backend failures were truncated JSON envelopes. Recognize this
  // specific reservation conflict even when the JSON can no longer be parsed.
  if (
    errorCode === "spending_reservation_busy" ||
    (input.includes("streamSpendingReservations") &&
      input.includes("changed while this mutation was being run"))
  ) {
    return {
      code: "spending_reservation_busy",
      message:
        "MCPJam could not reserve spending capacity because concurrent requests kept changing it. This is an internal execution failure. Retry this attempt.",
    };
  }
  if (isXaaConnectFailureReason(errorCode)) {
    return {
      message: (scrub(input) || XAA_REASON_FALLBACK_MESSAGES[errorCode]).slice(
        0,
        MAX_ATTEMPT_ERROR_CHARS
      ),
      code: errorCode,
      ...(isRerunnableXaaFailure(errorCode) ? { rerunnable: true } : {}),
    };
  }
  if (!input) return { message: "The session failed for an unknown reason." };

  let body = input;
  let httpStatus: number | undefined;

  const envelope = AGENT_ERROR_ENVELOPE.exec(input);
  if (envelope) {
    httpStatus = Number(envelope[1] ?? envelope[2]);
    body = input.slice(envelope[0].length).trim();
  }

  if (looksLikeErrorPage(body)) {
    return {
      code: "upstream_error_page",
      message: `The request was answered with an HTML error page instead of a response${
        httpStatus ? ` (HTTP ${httpStatus})` : ""
      }. This usually means a proxy or CDN blocked it.`,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
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
    ...(str(parsed.refusalReason)
      ? { refusalReason: str(parsed.refusalReason) }
      : {}),
    ...(typeof parsed.isRetryable === "boolean"
      ? { isRetryable: parsed.isRetryable }
      : {}),
    ...(num(parsed.outstandingHolds) !== undefined
      ? { outstandingHolds: num(parsed.outstandingHolds) }
      : {}),
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

/**
 * Backend denial codes whose limit belongs to the ACCOUNT rather than to one
 * host's own provider key. `spend_cap_exceeded` is the runner's own whole-run
 * finalize code; the rest mirror `USER_OWNED_DENIAL_CODES` in
 * `server/utils/mcpjam-stream-handler.ts`.
 *
 * Kept separate from that list: it answers who is at fault, this one whether
 * another host could escape the limit, and they already disagree on
 * `mcpjam_rate_limit`. A parity test pins the overlap so a code added there is
 * not silently missed here.
 */
const ACCOUNT_LIMIT_CODE =
  /\b(?:user_rate_limit|org_rate_limit|mcpjam_rate_limit|billing_limit_reached|spend_budget_reached|wallet_locked|billing_feature_not_included|free_tier_model_restricted|spend_cap_exceeded|platform_free_budget_exhausted|account_suspended|guest_model_not_allowed|guest_input_too_large)\b/i;

/**
 * True when a rate-limited attempt was stopped by MCPJam's account-wide limit
 * rather than by the user's own provider throttling their key.
 *
 * The two are indistinguishable on screen and need opposite advice: an account
 * limit is lifted by credit or BYOK, a provider limit only by waiting or
 * switching model — MCPJam cannot raise someone else's rate limit. Pass the
 * code alongside the message: {@link humanizeSwarmAttemptError} lifts it out of
 * the JSON envelope, so the cleaned sentence no longer carries it.
 */
export function isAccountLimit(
  message?: string | null,
  code?: string | null,
): boolean {
  if (accountLimitCode(message, code)) return true;
  return !!message && MCPJAM_MODEL_LIMIT_SENTENCE.test(message);
}

/**
 * The backend's own sentence for the free/credit model allowance
 * (`user_rate_limit` in `convex/stream/routes.ts` and `lib/llmCallShell.ts`).
 *
 * Only for rows written before the runner kept the denial code: those stored
 * this humanized sentence under the generic `rate_limited` code, so the
 * sentence is the one signal left that MCPJam — not the user's provider —
 * stopped the session.
 */
const MCPJAM_MODEL_LIMIT_SENTENCE =
  /\b(?:Daily|Monthly) MCPJam model limit reached\b/i;

/**
 * The account-limit denial code carried by a code or a raw failure message, in
 * its canonical lowercase spelling — or `undefined` when neither names one.
 *
 * The runner stores this as the attempt's `errorCode`. It has to be read off
 * the RAW message: the humanized sentence it stores beside it has already lost
 * the code.
 */
export function accountLimitCode(
  message?: string | null,
  code?: string | null,
): string | undefined {
  const match =
    (code ? ACCOUNT_LIMIT_CODE.exec(code) : null) ??
    (message ? ACCOUNT_LIMIT_CODE.exec(message) : null);
  return match?.[0].toLowerCase();
}
