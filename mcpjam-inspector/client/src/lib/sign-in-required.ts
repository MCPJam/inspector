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
 * The refusal's own copy when this error is one, `null` otherwise.
 *
 * Structured `ConvexError.data` first, then the stringified message. The
 * fallback is not defensive padding: `err.data` does not survive every path a
 * rejection takes to a hook (convex-test's function boundary drops it, and
 * Convex prefixes `Server Error` onto mutation rejections), while the
 * serialized payload is still in the text. Matching prose alone would be the
 * wrong fix — it breaks the day someone rewords the one part of a refusal that
 * is meant to change freely — so the code is what is matched, and the message
 * is only ever read out of the payload that carried it.
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
      // Not JSON after all — the code matched inside prose. Fall through.
    }
  }
  return FALLBACK_MESSAGE;
}

/** Convenience predicate for call sites that do not need the copy. */
export function isSignInRequired(error: unknown): boolean {
  return signInRequiredMessage(error) !== null;
}
