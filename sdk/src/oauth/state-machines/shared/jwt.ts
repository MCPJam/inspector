export function decodeJWT(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
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

export function formatJWTTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp * 1000).toLocaleString();
  } catch {
    return String(timestamp);
  }
}
