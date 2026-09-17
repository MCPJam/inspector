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
export const SIGN_IN_REQUIRED_CODE = "sign_in_required";

/** Last-resort copy when the refusal reached us without its own message. */
const FALLBACK_MESSAGE = "Sign in to use this.";

function messageFromRecord(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { code?: unknown; message?: unknown };
  if (record.code !== SIGN_IN_REQUIRED_CODE) return null;
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
  `["']?code["']?\\s*[:=]\\s*["']?${SIGN_IN_REQUIRED_CODE}\\b`
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
  if (!raw.includes(SIGN_IN_REQUIRED_CODE)) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      const fromText = messageFromRecord(parsed);
      if (fromText) return fromText;
    } catch {
      // Not JSON after all — fall through to the code-position check, which
      // is the only other thing that counts.
    }
  }
  return CODE_IN_CODE_POSITION.test(raw) ? FALLBACK_MESSAGE : null;
}

/** Convenience predicate for call sites that do not need the copy. */
export function isSignInRequired(error: unknown): boolean {
  return signInRequiredMessage(error) !== null;
}
