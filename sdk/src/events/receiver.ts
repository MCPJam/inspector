/** Receivers available without an MCPJam relay. */
export type ReceiverChoice = { kind: "local" } | { kind: "custom"; baseUrl: string };

export const DEFAULT_LOCAL_WEBHOOK_TTL_MS = 600_000;

export function checkCallbackUrl(
  value: string,
): { ok: true; url: URL; insecure: boolean } | { ok: false; reason: string } {
  const input = value.trim();
  if (!URL.canParse(input)) {
    return { ok: false, reason: "Enter a full callback URL beginning with https:// or http://." };
  }
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Use https:// or http:// for the callback URL." };
  }
  const authority = /^https?:\/\/([^/\\?#]+)/i.exec(input)?.[1];
  if (!authority) {
    return { ok: false, reason: "Enter a full callback URL beginning with https:// or http://." };
  }
  if (url.username || url.password || authority.includes("@")) {
    return { ok: false, reason: "Remove the credentials from the callback URL." };
  }
  if (url.href.includes("?") || url.href.includes("#")) {
    return { ok: false, reason: "Remove the query string or fragment from the callback URL." };
  }
  return { ok: true, url, insecure: url.protocol === "http:" };
}
