import { ConvexError } from "convex/values";

/**
 * The backend's structured refusal for an ANONYMOUS caller on a platform-paid
 * surface. Defined in the backend as `SIGN_IN_REQUIRED_CODE`
 * (`convex/lib/featureGates.ts`); this is the client half of that contract.
 *
 * Five backend doors throw it — swarm generation, swarm cluster rebuild, wave
 * insights, server quality and run insights — because all five spend the
 * platform's money rather than the caller's, and a guest has no organization
 * to charge. They share one code precisely so the Inspector handles it ONCE:
 * five codes would be five chances to classify a refusal as a fault.
 *
 * It is deliberately not `FEATURE_UNAVAILABLE` and not `forbidden`:
 *
 *   - `FEATURE_UNAVAILABLE` makes the calling surface render nothing, which is
 *     right for a flag the reader cannot affect and wrong here, where the
 *     reader can fix it in one click.
 *   - `forbidden` is mapped to **404** at the transport boundary so a
 *     non-member cannot probe for resource existence, which would tell a guest
 *     their own run does not exist.
 */
export const SIGN_IN_REQUIRED_CODE = "SIGN_IN_REQUIRED";

/**
 * Both spellings, because both have existed.
 *
 * The backend settled on `SIGN_IN_REQUIRED` (`convex/lib/signInRequired.ts`).
 * An earlier revision of this contract used `sign_in_required`, and matching
 * only one of the two is precisely the failure this module exists to prevent:
 * a refusal the Inspector cannot classify falls through to the generic branch,
 * which sets `unavailable` and hides the surface from the one reader who could
 * fix it in a click. Comparison is case-insensitive rather than a list so a
 * third capitalization cannot reintroduce it.
 */
function isSignInRequiredCode(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.toLowerCase() === SIGN_IN_REQUIRED_CODE.toLowerCase()
  );
}

/** Last-resort copy when the refusal reached us without its own message. */
const FALLBACK_MESSAGE = "Sign in to use this.";

/** Does this parsed payload claim a code at all? See `signInRequiredMessage`. */
function hasCode(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function messageFromRecord(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { code?: unknown; message?: unknown };
  if (!isSignInRequiredCode(record.code)) return null;
  return typeof record.message === "string" && record.message.length > 0
    ? record.message
    : FALLBACK_MESSAGE;
}

/**
 * The code in a CODE POSITION, for a payload too mangled to parse.
 *
 * The bare presence of the string is not enough and must not be treated as
 * enough: `Could not find public function "sign_in_required_probe"` contains
 * it and is an entirely different failure. Classifying that as a refusal would
 * draw a sign-in call to action over a real error and — in
 * `useRunInsights`, which latches `authRefused` on this — suppress
 * auto-requests for the rest of the session.
 *
 * So the code counts only where a code actually appears: as the value of a
 * `code` key, with or without quotes, in JSON or in a console-style dump.
 */
const CODE_IN_CODE_POSITION = new RegExp(
  `["']?code["']?\\s*[:=]\\s*["']?${SIGN_IN_REQUIRED_CODE}\\b`,
  "i"
);

/**
 * The refusal's own copy when this error is one, `null` otherwise.
 *
 * Structured `ConvexError.data` first, then the stringified message. The
 * fallback path is not defensive padding: `err.data` does not survive every
 * path a rejection takes to a hook (convex-test's function boundary drops it,
 * and Convex prefixes `Server Error` onto mutation rejections), while the
 * serialized payload is still in the text.
 *
 * What is matched is always the CODE, never the prose — the message is the one
 * part of a refusal meant to change freely, so keying off it would break on
 * the next copy edit. And the code is only honoured where a code belongs: a
 * parsed payload whose `code` is the sentinel, or the sentinel in a code
 * position. Text that merely mentions it is somebody else's failure.
 */
export function signInRequiredMessage(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const fromData = messageFromRecord(error.data);
    if (fromData) return fromData;
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw.toLowerCase().includes(SIGN_IN_REQUIRED_CODE.toLowerCase()))
    return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      // A payload that parsed AND carries a `code` is AUTHORITATIVE: its code
      // is the refusal's code, and the text around it is not evidence of
      // anything. Falling through to the scan below would re-read that same
      // payload as prose, so
      //   {"code":"provider_error","message":"upstream returned code: sign_in_required"}
      // would classify as a sign-in refusal on the strength of a sentence
      // quoting somebody else's error.
      if (hasCode(parsed)) return messageFromRecord(parsed);
      // Parsed, but not a refusal envelope — it says nothing either way, so
      // the code-position scan below still gets its turn.
    } catch {
      // Not JSON after all — same.
    }
  }
  return CODE_IN_CODE_POSITION.test(raw) ? FALLBACK_MESSAGE : null;
}

/**
 * The sign-in remedy carried by a THROWN transport error, whichever error type
 * the route happened to raise.
 *
 * One owner, because the alternative already shipped a bug: the swarm proxy can
 * throw `SwarmGenerateError` (which has a `signInRequired` flag) or
 * `WebApiError` (which does not, but carries the backend's envelope in
 * `details`), and a consumer that recognized only the first showed a guest the
 * generic error card. A consumer asking this question should not have to know
 * which type it got, nor re-derive the answer from `details` itself.
 *
 * Returns the refusal's own copy, or `null` when this is not a sign-in refusal.
 */
export function signInRemedyMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    signInRequired?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const message =
    typeof candidate.message === "string" && candidate.message.length > 0
      ? candidate.message
      : FALLBACK_MESSAGE;
  // The flag, where the throwing path set one.
  if (candidate.signInRequired === true) return message;
  // Otherwise the backend's own envelope, forwarded verbatim in `details`.
  const details = candidate.details;
  if (details && typeof details === "object") {
    const code = (details as { code?: unknown }).code;
    if (isSignInRequiredCode(code)) return message;
  }
  return null;
}

/** Convenience predicate for call sites that do not need the copy. */
export function isSignInRequired(error: unknown): boolean {
  return signInRequiredMessage(error) !== null;
}
