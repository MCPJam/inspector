/**
 * Reads two facts off a mock grant without verifying it. Only the backend
 * signs or checks a grant, so nothing here is a security decision: one
 * refuses a grant offered over HTTP before any backend call, and the other
 * keeps a cached answer from outliving the grant it was given for.
 */

const GRANT_PURPOSE = "mock-grant";

function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
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

/** When the grant says it expires, in epoch milliseconds. */
export function grantExpiryMs(token: string): number | undefined {
  const exp = payloadOf(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}
