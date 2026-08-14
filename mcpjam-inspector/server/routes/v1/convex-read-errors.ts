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
 * The refusal messages the backend's authorization helpers throw:
 *
 *   `requireProjectRole`:   "Not a member of this project"
 *                           "Insufficient project permissions: requires <role>"
 *   `requireWorkspaceRole`: "Not a member of this workspace"
 *                           "Insufficient workspace permissions: requires <role>"
 *   `resolveAuthorizedChatSession`: "ChatSession not found or unauthorized"
 *
 * The workspace wordings matter because the user-testing reads
 * (`chatboxes:getChatbox`, `chatSessions:getSession`) authorize at WORKSPACE
 * scope — before they were matched here, a cross-workspace probe classified
 * as `upstream` and answered 502, which both paged Sentry and told the prober
 * the id exists somewhere they cannot see (404 = missing, 502 = exists).
 *
 * Deliberately NOT a loose "unauthorized"/"not found" match. Those words also
 * appear in failures that are OURS — an expired credential, a renamed or
 * undeployed function — and answering 404 to those tells a caller their
 * resource is gone during an outage.
 */
const MEMBERSHIP_REFUSAL =
  /not a member of this (?:project|workspace)|insufficient (?:project|workspace) permissions|chatsession not found or unauthorized/i;

/**
 * Convex rejected the ARGUMENTS before the handler ran — a caller-shaped id
 * that does not match `v.id(...)`, an enum value outside its union. On these
 * routes every Convex-validated argument is an id or an already-zod-validated
 * scalar, so this is "the resource you named cannot exist", which is a 404 —
 * and NOT an incident: classifying it `upstream` turned every stale-id retry
 * loop into a stream of 5xx Sentry events.
 */
const ARGUMENT_VALIDATION_FAILURE = /\bArgumentValidationError\b/i;

/**
 * Production Convex redacts a plain server-side `Error` to "Server Error" —
 * including the membership refusals above, which are plain errors upstream.
 * So in production a refusal and a genuine handler crash arrive as the same
 * string, and only the CALL SITE knows which reading is safe. See
 * `redactedIsRefusal` on `translateConvexReadError`.
 */
const REDACTED_SERVER_ERROR = /\bserver error\b/i;

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
  | { kind: "invalid-argument" }
  | { kind: "redacted" }
  | { kind: "upstream" };

export function classifyConvexReadError(error: unknown): ConvexReadFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (MEMBERSHIP_REFUSAL.test(message)) return { kind: "membership" };
  if (AUTHENTICATION_FAILURE.test(message)) return { kind: "authentication" };
  if (ARGUMENT_VALIDATION_FAILURE.test(message))
    return { kind: "invalid-argument" };
  if (REDACTED_SERVER_ERROR.test(message)) return { kind: "redacted" };
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
  options: {
    scope: string;
    notFoundMessage?: string;
    /**
     * Read a production-redacted "Server Error" as a refusal (→ 404) instead
     * of an outage (→ 502).
     *
     * ONLY for scoping preflights — reads whose job is to decide whether the
     * caller may see a caller-supplied id, and whose refusal paths are plain
     * errors upstream (workspace membership, authorized-session resolution)
     * that production Convex redacts to the same "Server Error" a genuine
     * crash produces. At a preflight, answering 502 to a refusal is an
     * existence oracle (404 = missing, 502 = exists elsewhere) plus a Sentry
     * page per probe; answering 404 to the rare genuine crash costs one
     * misleading status on a request that was about to fail anyway. Network
     * failures (`fetch failed`, timeouts) never match the redaction shape and
     * still answer 502, so an outage does not read as mass deletion.
     *
     * Post-preflight reads must NOT set this: their upstream failures are
     * real incidents and 404 would hide them.
     */
    redactedIsRefusal?: boolean;
  }
): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const failure = classifyConvexReadError(error);
  if (
    failure.kind === "membership" ||
    // A caller-shaped id Convex's validator rejected cannot name a resource
    // the caller may see; not an incident, so no Sentry — see
    // ARGUMENT_VALIDATION_FAILURE.
    failure.kind === "invalid-argument" ||
    (failure.kind === "redacted" && options.redactedIsRefusal === true)
  ) {
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
