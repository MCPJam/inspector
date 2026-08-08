/**
 * How a Convex FUNCTION-CALL failure becomes an HTTP answer, for the v1 routes
 * that call Convex directly instead of proxying.
 *
 * Shared because it was written twice — `journeys.ts` and `scenarios.ts` — and
 * a classifier that decides between "you cannot see this", "your credential is
 * bad" and "we are broken" is exactly the thing that must not drift between
 * two copies. Convex reports all three as prose, so the shape is all there is
 * to match on, and the strings are the ones its authorization helper actually
 * throws.
 */
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { logger } from "../../utils/logger.js";

/**
 * The two messages `requireProjectRole` throws:
 *
 *   "Not a member of this project"
 *   "Insufficient project permissions: requires <role>"
 *
 * Deliberately NOT a loose "unauthorized"/"not found" match. Those words also
 * appear in failures that are OURS — an expired credential, a renamed or
 * undeployed function — and answering 404 to those tells a caller their
 * resource is gone during an outage.
 */
const MEMBERSHIP_REFUSAL =
  /not a member of this project|insufficient project permissions/i;

/**
 * A bad or expired CREDENTIAL, which is neither the caller's resource being
 * missing nor our service being down. It gets its own answer because the two
 * neighbours are both wrong for it: 404 tells a client to forget the resource,
 * and 502 tells it to retry — which it will do forever, with the same dead
 * token, until someone reads a log.
 */
const AUTHENTICATION_FAILURE =
  /\b(unauthenticated|invalid token|token (has )?expired|expired token|jwt)\b/i;

export type ConvexReadFailure =
  | { kind: "membership" }
  | { kind: "authentication" }
  | { kind: "upstream" };

export function classifyConvexReadError(error: unknown): ConvexReadFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (MEMBERSHIP_REFUSAL.test(message)) return { kind: "membership" };
  if (AUTHENTICATION_FAILURE.test(message)) return { kind: "authentication" };
  return { kind: "upstream" };
}

/**
 * Turn a Convex read failure into the response the caller should get.
 *
 * `notFoundMessage` is the one thing that varies between routes — "Not found"
 * versus "Environment not found" — because the 404 here is deliberately
 * indistinguishable from a genuinely missing resource: answering 403 would
 * confirm the thing exists to someone who cannot see it.
 *
 * The upstream branch never forwards Convex's text. It is written for us: it
 * can carry function names, argument-validator output with the arguments in
 * it, and request ids that mean nothing to a caller and are a free read of our
 * internals to anyone else. The detail goes to the log instead.
 */
/**
 * What we are willing to put in a log line.
 *
 * Convex's failure text is written for us, and an argument-validator failure
 * quotes the ARGUMENTS — which on these routes can include ids and, on a
 * write, whatever the caller sent. Sentry and Axiom are a wider audience than
 * a server console, so the obvious credential shapes come out and the rest is
 * capped: a validator dump is long, and the first few hundred characters are
 * the part anyone reads.
 *
 * NOT a general PII scrubber, and not sold as one — it removes the things that
 * are recognizable as secrets by shape. The real protection is that this text
 * never reaches the RESPONSE; this only narrows what an operator's tooling
 * accumulates.
 */
const LOG_MESSAGE_MAX = 400;

function redactForLog(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    // `Bearer <token>`, and the token on its own if it has a known prefix.
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(sk|slk|dsc|api)_[A-Za-z0-9._-]+/g, "$1_[redacted]")
    // Anything JWT-shaped.
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[redacted-jwt]");
  return scrubbed.length > LOG_MESSAGE_MAX
    ? `${scrubbed.slice(0, LOG_MESSAGE_MAX)}… [truncated]`
    : scrubbed;
}

export function translateConvexReadError(
  error: unknown,
  options: { scope: string; notFoundMessage?: string }
): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const failure = classifyConvexReadError(error);
  if (failure.kind === "membership") {
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      options.notFoundMessage ?? "Not found"
    );
  }
  if (failure.kind === "authentication") {
    return new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Invalid or expired credentials."
    );
  }
  // The REDACTED error, not the original. `logger.error` hands its second
  // argument to `Sentry.captureException`, which reads `.message` off it — so
  // redacting only the structured field left the raw text going to Sentry
  // anyway and made the scrubbing decorative.
  //
  // AND the stack has to be rebuilt, not copied. A JS stack string BEGINS with
  // `Error: <message>`, so transplanting the original stack onto a redacted
  // error puts the unredacted message straight back as its first line — the
  // same leak, one field over. Only the frames come across; the header is the
  // redacted message.
  const redacted = new Error(redactForLog(error));
  if (error instanceof Error && error.stack) {
    const frames = error.stack
      .split("\n")
      .filter((line) => /^\s+at\s/.test(line));
    if (frames.length > 0) {
      redacted.stack = [`Error: ${redacted.message}`, ...frames].join("\n");
    }
  }
  logger.error(`[${options.scope}] upstream read failed`, redacted, {
    message: redacted.message,
  });
  return new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    "Upstream request failed"
  );
}
