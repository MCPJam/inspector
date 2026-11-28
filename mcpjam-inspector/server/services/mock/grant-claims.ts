/**
 * Reads one fact off a mock grant without verifying it. Only the backend signs
 * or checks a grant, so nothing here is a security decision: it only lets the
 * HTTP door turn away a grant offered as a bearer before any backend call.
 */

const GRANT_PURPOSE = "mock-grant";

function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when `token` is shaped as, and says it is, a mock grant. */
export function looksLikeMockGrant(token: string): boolean {
  return payloadOf(token)?.purpose === GRANT_PURPOSE;
}
