import { isCredentialShapedAuthValue } from "./oauth/state-machines/trace-redaction.js";

export function redactForTelemetry(value: unknown): unknown {
  return redactForTelemetryAtPath(value, []);
}

/**
 * String-specialized `redactForTelemetry`, for the sinks that hold a message
 * rather than a payload — a thrown error, a log line, a Sentry exception value.
 *
 * The redactor already scrubs strings, but it is typed `unknown -> unknown`, so
 * every message-shaped caller otherwise re-narrows the result itself. Three
 * modules grew a private copy of exactly this (`error-describer/describe.ts`,
 * `conformance-redaction.ts`, `xaa/state-machines/state-machine.ts`); this is
 * the one they should collapse onto, so a fourth does not appear.
 */
export function redactTelemetryString(value: string): string {
  const redacted = redactForTelemetry(value);
  return typeof redacted === "string" ? redacted : value;
}

function redactForTelemetryAtPath(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactForTelemetryAtPath(entry, path));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSensitiveString(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedactKey(key, entryValue, path)
        ? "[REDACTED]"
        : redactForTelemetryAtPath(entryValue, [...path, key]),
    ])
  );
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
      (_match, headerName: string) => `${headerName}: [REDACTED]`
    )
    .replace(/\bBearer(\s+)(\S+)/giu, redactBareBearerMatch)
    .replace(
      /\b(access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier)=([^&\s]+)/giu,
      "$1=[REDACTED]"
    )
    .replace(
      /(["']?(?:access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier)["']?\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2"
    );
}

/**
 * Replacer for a bare `Bearer <value>` with no header context.
 *
 * Over-redacting is this module's whole posture, but not onto the scheme word's
 * own sentence: the hosted 401 for a bearer-less `/api/web/*` request says
 * "Bearer token required", and the previous rule ate the noun after `Bearer` —
 * publishing "Bearer [REDACTED] required" through `describeError` into the
 * error banner a user reads. `isCredentialShapedAuthValue` owns the
 * credential-vs-vocabulary call for both redactors, so the two cannot drift.
 */
function redactBareBearerMatch(
  match: string,
  gap: string,
  value: string
): string {
  // A `name=value` pair belongs to the parameter rule below it, which keeps the
  // NAME — the diagnostic half — and redacts only the value.
  if (/^[A-Za-z_][A-Za-z0-9_-]*=/u.test(value)) return match;
  return isCredentialShapedAuthValue(value) ? `Bearer${gap}[REDACTED]` : match;
}

function shouldRedactKey(key: string, value: unknown, path: string[]): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");

  if (normalized === "code") {
    return shouldRedactAuthorizationCodeValue(value, path);
  }

  if (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie"
  ) {
    return true;
  }

  return (
    ((normalized === "codeverifier" ||
      normalized === "accesstoken" ||
      normalized.endsWith("accesstoken") ||
      normalized === "refreshtoken" ||
      normalized.endsWith("refreshtoken") ||
      normalized === "clientsecret" ||
      normalized.endsWith("clientsecret") ||
      normalized === "idtoken" ||
      normalized.endsWith("idtoken")) &&
      shouldRedactSecretValue(value)) ||
    normalized === "apikey" ||
    normalized === "xapikey"
  );
}

function shouldRedactSecretValue(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function shouldRedactAuthorizationCodeValue(
  value: unknown,
  path: string[]
): boolean {
  if (
    path[path.length - 1] === "error" ||
    path[path.length - 1] === "snapshotError"
  ) {
    return false;
  }

  if (typeof value !== "string") {
    return false;
  }

  if (/^[A-Z0-9_:-]+$/u.test(value)) {
    return false;
  }

  return value.length > 0;
}
