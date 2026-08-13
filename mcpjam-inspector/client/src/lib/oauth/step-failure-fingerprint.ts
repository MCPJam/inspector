/**
 * Grouping keys for OAuth debugger step failures (INSPECTOR-CLIENT-22N).
 *
 * Every failure is reported from one `new Error(...)`, so Sentry's stack-based
 * grouping collapses them all into one issue. These need an explicit key — but
 * the messages carry per-user values, so grouping on them raw trades one
 * useless bucket for one issue per user.
 */

/** Volatile spans, replaced before grouping. URLs first: they contain the
 * colons and digits the later patterns match. */
const VOLATILE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Any scheme; stops at quotes so it does not eat trailing punctuation.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s`'"<>]+/g, "<url>"],
  // IPv6, including the `::` compressed form.
  [/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\b/g, "<ip>"],
  // IPv4 with an optional port, so `127.0.0.1:9876` collapses as one span.
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>"],
  // Client ids, request ids, hashes.
  [/\b[0-9a-f]{8,}\b/g, "<id>"],
  // Ports and timestamps. HTTP status codes are 3 digits, so they survive —
  // 400 vs 500 is a real difference in failure class.
  [/\b\d{4,}\b/g, "<n>"],
];

/** Long enough to keep the two `invalid_client` variants apart. */
const MAX_FINGERPRINT_MESSAGE = 200;

/** Reduce a message to what identifies its failure class. Exported for tests. */
export function normalizeStepFailureMessage(message: string): string {
  let normalized = message.toLowerCase();
  for (const [pattern, placeholder] of VOLATILE_PATTERNS) {
    normalized = normalized.replace(pattern, placeholder);
  }
  return normalized
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINGERPRINT_MESSAGE);
}

/**
 * `step` is in the key because the same words mean different bugs at different
 * points in the flow. `protocolVersion` is not — it ships as a tag, so it stays
 * filterable without multiplying every issue by four.
 */
export function oauthStepFailureFingerprint(
  step: string,
  message: string,
): string[] {
  return [
    "oauth_debugger_step",
    step,
    normalizeStepFailureMessage(message) || "<empty>",
  ];
}
