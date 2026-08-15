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

export function redactForLog(error: unknown): string {
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
