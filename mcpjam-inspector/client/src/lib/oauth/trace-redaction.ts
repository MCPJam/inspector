/**
 * Redaction for OAuth trace *display* data collected by the client itself.
 *
 * The SDK's `projectOAuthTraceSnapshot({ sanitize })` covers everything derived
 * from a state machine's `httpHistory`/`infoLogs`. It does not cover the trace
 * entries the client builds directly — `failOAuthTraceStep`, the OAuth proxy's
 * transport-failure entry — and the refresh flow produces ONLY those. This
 * module is the client's half of the same boundary.
 *
 * Nothing here may be applied to data the OAuth flow CONSUMES. See the comment
 * on `parseOAuthResponseBody` in `mcp-oauth.ts`: running a live token response
 * through a redactor produces a non-empty string that passes every truthiness
 * check and then fails upstream as `Bearer abcd...[redacted]...yz`.
 */

import { SANITIZE_OAUTH_TRACES } from "@/lib/config";

/**
 * Bound the untrusted text before it leaves the browser.
 *
 * These strings come from the server UNDER TEST — an `error_description` is
 * whatever that server chose to return, and MCPJam is routinely pointed at
 * half-built servers that echo request context back into error bodies. A
 * diagnostic signal must not become an exfiltration path, so every shape a
 * credential plausibly arrives in gets redacted before capture:
 *
 *   1. URL userinfo, with or without a scheme (`https://u:p@h`, `u:p@h`)
 *   2. credential-ish query/form parameters, by name
 *   3. `Authorization: Bearer|Basic <value>` echoed from a request
 *   4. JSON credential fields (`"client_secret": "..."`)
 *
 * Then a length cap, because an upstream body can be arbitrarily large.
 *
 * Deliberately over-redacts: losing a token's value costs nothing here (the
 * parameter NAME is the diagnostic), while leaking one is unrecoverable. What
 * it must NOT do is destroy diagnostic vocabulary — "Bearer token is expired"
 * has to survive intact, which is why rule 3b matches only credential-shaped
 * values.
 */
const CREDENTIAL_PARAM_NAMES =
  "client_secret|access_token|refresh_token|id_token|code_verifier|code|assertion|password|api[-_]?key|token|secret";

/** Final length of a reported message. */
const MAX_REPORTED = 500;

/**
 * How much raw input the redactors are allowed to scan.
 *
 * The cap has to come BEFORE the replace chain — an upstream body can be
 * megabytes, and four global regexes over it would copy the whole thing four
 * times on a render path. It is deliberately wider than `MAX_REPORTED` so the
 * redactors still see the context around anything that survives to the output.
 */
const MAX_SCANNED = 4_000;

export function sanitizeStepError(message: string): string {
  const truncated = message.length > MAX_SCANNED;
  const bounded = truncated ? message.slice(0, MAX_SCANNED) : message;

  const redacted = bounded
    // 1a. scheme://user:pass@host. Greedy up to the LAST `@` of the
    // authority: `@` is legal inside a password, so
    // `https://user:secret@part@host` has userinfo `user:secret@part`, and
    // stopping at the first `@` would report half the password.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[redacted]@")
    // 1b. bare user:pass@host (no scheme), same greediness.
    .replace(/(^|[\s(<"'])[^\s/@:]+:[^\s/]+@(?=[\w.-]+)/g, "$1[redacted]@")
    // 2. ?client_secret=… / &token=…
    .replace(
      new RegExp(`\\b(${CREDENTIAL_PARAM_NAMES})=[^&\\s"'<>]+`, "gi"),
      "$1=[redacted]",
    )
    // 3a. An echoed `Authorization:` header — redact whatever follows.
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)(bearer|basic)\s+\S+/gi,
      "$1$2 [redacted]",
    )
    // 3b. A bare `Bearer <value>` with no header context. This one must only
    // fire on a credential-SHAPED value: `\b(bearer|basic)\s+\w+` turns the
    // very common "Bearer token is expired" into "Bearer [redacted] is
    // expired", destroying the diagnostic word this function promises to keep.
    // Real values carry base64url/JWT punctuation or are simply long.
    .replace(
      /\b(bearer|basic)\s+(?:[\w-]*[._~+/=][\w\-._~+/=]*|\w{20,})/gi,
      "$1 [redacted]",
    )
    // 4. "client_secret": "…" — `(?:\\.|[^"\\])*` rather than `[^"]*`, or an
    // escaped quote inside the value ends the match early and leaves the
    // secret's tail in the report.
    .replace(
      new RegExp(
        `("(?:${CREDENTIAL_PARAM_NAMES})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
        "gi",
      ),
      '$1"[redacted]"',
    );

  // Patterns 1b/2/3 all match to end-of-string, so a value the cap cut in half
  // is still redacted. The JSON and scheme-userinfo forms need a closing
  // delimiter, so cutting mid-value would leave a raw prefix — close those two
  // here, and only when the cap actually fired, so an ordinary message that
  // merely ends in a URL keeps its hostname.
  const tailGuarded = truncated
    ? redacted
        .replace(
          // Escape-aware like the terminated form above, or an unterminated
          // value containing `\\"` stops the match at that quote and leaks its
          // tail. `[\\s\\S]?` so a trailing backslash at the cut still matches.
          new RegExp(
            `("(?:${CREDENTIAL_PARAM_NAMES})"\\s*:\\s*)"(?:\\\\[\\s\\S]?|[^"\\\\])*$`,
            "gi",
          ),
          '$1"[redacted]',
        )
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*$/gi, "$1[redacted]")
    : redacted;

  return tailGuarded.slice(0, MAX_REPORTED);
}

/**
 * The gated entry point for trace *collection*. Mirrors `traceOAuthValue` /
 * `traceOAuthHeaders` in `mcp-oauth.ts`: on locally, redacting when hosted.
 *
 * Local dev keeps raw error text because the whole point of the inspector is
 * to show the user what their own server actually said; hosted traces are
 * persisted, copied, and shipped, so they get the redactor.
 */
export function traceOAuthErrorMessage(message: string): string {
  return SANITIZE_OAUTH_TRACES ? sanitizeStepError(message) : message;
}
