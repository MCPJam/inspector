import { decodeJwt } from "jose";

// Presentation continuity only. Decoded claims grant no access: every operation
// still sends the current credential to the server for fresh verification.
function sameRefreshIdentity(left: string, right: string): boolean {
  const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/i;
  const a = bearer.exec(left)?.[1],
    b = bearer.exec(right)?.[1];
  if (!a || !b || a.length > 16_384 || b.length > 16_384) return false;
  try {
    const first = decodeJwt(a),
      second = decodeJwt(b);
    for (const claims of [first, second]) {
      if (
        typeof claims.iss !== "string" ||
        !claims.iss ||
        typeof claims.sub !== "string" ||
        !claims.sub ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        typeof claims.iat !== "number" ||
        !Number.isFinite(claims.iat) ||
        (claims.jti !== undefined && typeof claims.jti !== "string")
      )
        return false;
    }
    const refreshed = new Set(["exp", "iat", "jti"]);
    const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
    return [...keys].every(
      (key) =>
        refreshed.has(key) ||
        JSON.stringify(first[key]) === JSON.stringify(second[key]),
    );
  } catch {
    return false;
  }
}

/** Keep a chat on token refresh; opaque keys, identity and scope changes reset it. */
export function sameChatAuthSession(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      a[key] === b[key] ||
      (key.toLowerCase() === "authorization" &&
        typeof b[key] === "string" &&
        sameRefreshIdentity(a[key], b[key])),
  );
}
