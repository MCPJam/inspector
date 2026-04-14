function toBase64Url(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
      "",
    );
    return globalThis
      .btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  throw new Error("No base64 encoder available");
}

export function generateRandomString(length: number): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(
    randomValues,
    (byte) => charset[byte % charset.length],
  ).join("");
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(hash));
}
