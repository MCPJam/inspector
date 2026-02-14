import type { OAuthTokens } from "@/types/server-types";

const TOKENS_KEY_PREFIX = "mcpjam-web-oauth-tokens-";

function tokensKey(serverId: string) {
  return `${TOKENS_KEY_PREFIX}${serverId}`;
}

export function getStoredTokens(serverId: string): OAuthTokens | null {
  const raw = localStorage.getItem(tokensKey(serverId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    return null;
  }
}

export function hasOAuthConfig(serverId: string): boolean {
  return getStoredTokens(serverId) != null;
}
