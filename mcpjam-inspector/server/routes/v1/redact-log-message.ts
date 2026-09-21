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

/** Where a value ends when it is not quoted: whitespace or a structural char. */
const BARE_VALUE = String.raw`[^\s"'\`&,)\]}]+`;

/**
 * ONE alternation, applied in ONE pass — not a chain of `.replace()` calls.
 *
 * The chain version was wrong twice over, and both bugs came from the same
 * property: each pass re-scans the OUTPUT of the previous one. `api_key=x`
 * became `api_key=[redacted]` and then the bare-prefix rule matched the NAME
 * inside that result and produced `api_[redacted]=[redacted]`; the standalone
 * Bearer rule did the same to an already-redacted authorization value. A
 * single pass never revisits what it has already replaced, so the rules cannot
 * corrupt each other and their order expresses precedence only.
 *
 * Order within the alternation IS precedence: JS alternation is first-match at
 * each position, so the key=value form gets the chance to consume a whole
 * `api_key: "…"` pair before the bare-prefix rule can nibble the key name.
 *
 * The value branches, in order, are what the earlier version got wrong:
 *   - a fully quoted string, so `token="two words"` does not leak its tail at
 *     the first space;
 *   - a scheme-prefixed credential, so `authorization: Basic dXNlcj…` does not
 *     leak the part after `Basic`;
 *   - a bare run, which stops at `&` or `,` so surrounding non-secret context
 *     (`&projectId=proj_123`) survives — that context is what makes the line
 *     worth logging at all.
 *
 * The key may itself be quoted, so JSON (`{"api_key": "hunter2"}`) matches;
 * without that the whole pair was skipped and the secret shipped verbatim.
 */
const CREDENTIAL_PATTERN = new RegExp(
  [
    // key = value / "key": "value"
    String.raw`["']?\b(api[-_]?key|secret|token|password|passwd|authorization)\b["']?\s*[=:]\s*` +
      String.raw`(?:"[^"]*"|'[^']*'|(?:Bearer|Basic|Token)\s+${BARE_VALUE}|${BARE_VALUE})`,
    // A standalone scheme + credential with no key name in front of it.
    String.raw`\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*`,
    // Bare credentials recognizable by their own prefix.
    String.raw`\b(?:sk|slk|dsc|api)_[A-Za-z0-9._-]+`,
    // Anything JWT-shaped.
    String.raw`\beyJ[A-Za-z0-9._-]{10,}`,
  ].join("|"),
  "gi"
);

export function redactForLog(error: unknown): string {
  const scrubbed = safeErrorText(error).replace(
    CREDENTIAL_PATTERN,
    (match, keyName?: string) => {
      // Keep the key so the line still says WHICH credential was rejected —
      // that is the diagnostic value; the secret is not.
      if (keyName) return `${keyName}=[redacted]`;
      const scheme = /^(Bearer|Basic)\b/i.exec(match);
      if (scheme) return `${scheme[1]} [redacted]`;
      const prefix = /^(sk|slk|dsc|api)_/.exec(match);
      if (prefix) return `${prefix[1]}_[redacted]`;
      return "[redacted-jwt]";
    }
  );
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
