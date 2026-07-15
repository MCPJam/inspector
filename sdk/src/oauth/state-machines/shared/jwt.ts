export interface DecodedJwtParts {
  header: Record<string, any> | null;
  payload: Record<string, any> | null;
  signature: string;
}

// Decode one base64url JWT segment to JSON. Browser-safe: prefers `atob`, falls
// back to `Buffer` under Node. Returns null on malformed input.
function decodeBase64UrlJson(segment: string): Record<string, any> | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const paddedBase64 = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

    let decoded: string;
    if (typeof globalThis.atob === "function") {
      decoded = globalThis.atob(paddedBase64);
    } else if (typeof Buffer !== "undefined") {
      decoded = Buffer.from(paddedBase64, "base64").toString("utf-8");
    } else {
      return null;
    }

    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// Decode a JWT's header, payload, and raw signature segment without verifying.
// Needed by the XAA ID-JAG inspector, which surfaces the header (alg/typ/kid)
// and signature alongside the claims.
export function decodeJWTParts(token: string): DecodedJwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  return {
    header: decodeBase64UrlJson(parts[0]),
    payload: decodeBase64UrlJson(parts[1]),
    signature: parts[2],
  };
}

// Decode a JWT's payload without verifying. Returns null on malformed input.
export function decodeJWT(token: string): Record<string, any> | null {
  return decodeJWTParts(token)?.payload ?? null;
}

export function formatJWTTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp * 1000).toLocaleString();
  } catch {
    return String(timestamp);
  }
}
