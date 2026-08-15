/**
 * What we are willing to put in a log line about a Convex failure.
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
 *
 * Shared by the READ translator (`convex-read-errors.ts`) and the WRITE one
 * (`convex-errors.ts`). It lives in its own module rather than being exported
 * from whichever adopted it first: the two files are peers, and a redactor
 * that drifts between them is the same failure the write translator's own
 * header describes — five copies of one rule, five different answers.
 */
const LOG_MESSAGE_MAX = 400;

/**
 * `error.message` and `String(error)` both run a Proxy `get`/`toString` trap
 * and can therefore throw. This function only ever runs while something ELSE
 * has already failed, so a throw here escapes into the catch block that was
 * reporting that failure — losing the original diagnostic and replacing the
 * route's answer with a secondary failure from the logging code. Same rule,
 * and the same fallback string, as `logger.ts`'s `safeErrorText`.
 */
function safeErrorText(error: unknown): string {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    // `Error.message` is only a string by convention — `new Error()` with a
    // mutated or subclassed `message` can hand back anything.
    return typeof raw === "string" ? raw : String(raw);
  } catch {
    return "[unreadable error value]";
  }
}

export function redactForLog(error: unknown): string {
  const scrubbed = safeErrorText(error)
    // KEY=VALUE forms FIRST, and the ordering is the whole point of this
    // sequence. The bare-prefix rule below matches the NAME `api_key`, so on
    // its own it rewrites `api_key=hunter2` to `api_[redacted]=hunter2` —
    // redacting the label and publishing the secret.
    //
    // The optional `Bearer ` inside the value is what stops the standalone
    // Bearer rule from firing afterwards and leaving a double-redacted
    // `authorization=[redacted] [redacted]`. Everything up to whitespace, a
    // quote, an ampersand or a closing bracket is the value, so surrounding
    // non-secret context (`&projectId=proj_123`) survives — that context is
    // what makes the log line worth keeping.
    .replace(
      /\b(api[-_]?key|secret|token|password|passwd|authorization)\s*[=:]\s*(?:Bearer\s+)?["']?[^\s"'`&,)\]}]+/gi,
      "$1=[redacted]"
    )
    // A standalone `Bearer <token>` with no key name in front of it.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    // Bare credentials recognizable by their own prefix.
    .replace(/\b(sk|slk|dsc|api)_[A-Za-z0-9._-]+/g, "$1_[redacted]")
    // Anything JWT-shaped.
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[redacted-jwt]");
  return scrubbed.length > LOG_MESSAGE_MAX
    ? `${scrubbed.slice(0, LOG_MESSAGE_MAX)}… [truncated]`
    : scrubbed;
}

/**
 * A redacted `Error` safe to hand to `logger.error` — which forwards its
 * second argument to `Sentry.captureException`, and Sentry reads `.message`
 * off it. Redacting only the structured log field leaves the raw text going to
 * Sentry anyway and makes the scrubbing decorative.
 *
 * The stack has to be REBUILT, not copied. A JS stack string BEGINS with
 * `Error: <message>`, so transplanting the original stack onto a redacted
 * error puts the unredacted message straight back as its first line — the same
 * leak, one field over. Only the frames come across; the header is the
 * redacted message.
 */
export function redactedErrorForCapture(error: unknown): Error {
  const redacted = new Error(redactForLog(error));
  if (error instanceof Error && error.stack) {
    const frames = error.stack
      .split("\n")
      .filter((line) => /^\s+at\s/.test(line));
    if (frames.length > 0) {
      redacted.stack = [`Error: ${redacted.message}`, ...frames].join("\n");
    }
  }
  return redacted;
}
