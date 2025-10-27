/**
 * Safely decode a JWT token without verification
 * Returns the decoded payload or null if invalid
 */
export function decodeJWT(token: string): Record<string, any> | null {
  try {
    // JWT format: header.payload.signature
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    // Decode the payload (second part)
    const payload = parts[1];

    // Handle base64url decoding (replace - with + and _ with /)
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");

    // Add padding if needed
    const paddedBase64 = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

    // Decode base64 to string
    const decoded = atob(paddedBase64);

    // Parse JSON
    return JSON.parse(decoded);
  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return null;
  }
}

/**
 * Decode JWT header
 */
export function decodeJWTHeader(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const header = parts[0];
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const paddedBase64 = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(paddedBase64);

    return JSON.parse(decoded);
  } catch (error) {
    console.error("Failed to decode JWT header:", error);
    return null;
  }
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
