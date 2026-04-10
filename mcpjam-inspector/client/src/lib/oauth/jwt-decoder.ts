export interface DecodedJwtParts {
  header: Record<string, any> | null;
  payload: Record<string, any> | null;
  signature: string;
}

function decodeJwtPart(encoded: string): Record<string, any> | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const paddedBase64 = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(paddedBase64));
  } catch {
    return null;
  }
}

/**
 * Safely decode a JWT token without verification
 * Returns the decoded payload or null if invalid
 */
export function decodeJWT(token: string): Record<string, any> | null {
  const decoded = decodeJWTParts(token);
  if (!decoded) {
    console.error("Failed to decode JWT");
    return null;
  }

  return decoded.payload;
}

export function decodeJWTParts(token: string): DecodedJwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  return {
    header: decodeJwtPart(parts[0]),
    payload: decodeJwtPart(parts[1]),
    signature: parts[2],
  };
}

/**
 * Format timestamp to readable date
 */
export function formatJWTTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp * 1000).toLocaleString();
  } catch {
    return String(timestamp);
  }
}
