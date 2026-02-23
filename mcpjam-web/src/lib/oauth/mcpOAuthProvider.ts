import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { MCPOAuthConfig } from "../../hooks/mcpConnectionsContext";

const CLIENT_INFO_KEY_PREFIX = "mcpjam-web-oauth-client-";
const TOKENS_KEY_PREFIX = "mcpjam-web-oauth-tokens-";
const VERIFIER_KEY_PREFIX = "mcpjam-web-oauth-verifier-";
const PENDING_KEY = "mcpjam-web-oauth-pending-server-id";
const RETURN_HASH_KEY = "mcpjam-web-oauth-return-hash";

function clientInfoKey(serverId: string) {
  return `${CLIENT_INFO_KEY_PREFIX}${serverId}`;
}

function tokensKey(serverId: string) {
  return `${TOKENS_KEY_PREFIX}${serverId}`;
}

function verifierKey(serverId: string) {
  return `${VERIFIER_KEY_PREFIX}${serverId}`;
}

function getFromStorage<T>(key: string): T | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function setInStorage(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function setPendingOAuthServer(serverId: string) {
  localStorage.setItem(PENDING_KEY, serverId);
}

export function getPendingOAuthServer(): string | null {
  return localStorage.getItem(PENDING_KEY);
}

export function clearPendingOAuthServer() {
  localStorage.removeItem(PENDING_KEY);
}

export function setOAuthReturnHash(hash: string) {
  localStorage.setItem(RETURN_HASH_KEY, hash);
}

export function consumeOAuthReturnHash(): string | null {
  const hash = localStorage.getItem(RETURN_HASH_KEY);
  if (hash) {
    localStorage.removeItem(RETURN_HASH_KEY);
  }
  return hash;
}

export function getStoredOAuthTokens(serverId: string) {
  return getFromStorage<Record<string, unknown>>(tokensKey(serverId));
}

interface ProviderConfig {
  serverId: string;
  serverName: string;
  serverUrl: string;
  oauth?: MCPOAuthConfig;
}

export function createMcpOAuthProvider({
  serverId,
  serverName,
  serverUrl,
  oauth,
}: ProviderConfig): OAuthClientProvider {
  const redirectUri = `${window.location.origin}${window.location.pathname}`;

  return {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata() {
      return {
        client_name: `MCPJam Web - ${serverName}`,
        client_uri: "https://mcpjam.com",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: oauth?.clientSecret ? "client_secret_post" : "none",
      };
    },
    state() {
      return crypto.randomUUID();
    },
    clientInformation() {
      const stored = getFromStorage<Record<string, unknown>>(clientInfoKey(serverId));
      if (!stored) {
        const preset: Record<string, unknown> = {
          redirect_uris: [redirectUri],
        };
        if (oauth?.clientId) {
          preset.client_id = oauth.clientId;
        }
        if (oauth?.clientSecret) {
          preset.client_secret = oauth.clientSecret;
        }
        return oauth?.clientId
          ? (preset as OAuthClientInformationMixed)
          : undefined;
      }

      const next = { ...stored };
      if (!next.redirect_uris) {
        next.redirect_uris = [redirectUri];
      }
      if (oauth?.clientId) next.client_id = oauth.clientId;
      if (oauth?.clientSecret) next.client_secret = oauth.clientSecret;
      return next as OAuthClientInformationMixed;
    },
    saveClientInformation(clientInformation) {
      setInStorage(clientInfoKey(serverId), clientInformation);
    },
    tokens() {
      return getFromStorage(tokensKey(serverId));
    },
    saveTokens(tokens) {
      setInStorage(tokensKey(serverId), tokens);
    },
    redirectToAuthorization(authorizationUrl) {
      setPendingOAuthServer(serverId);
      setOAuthReturnHash(window.location.hash || "#servers");
      localStorage.setItem(`mcpjam-web-oauth-server-url-${serverId}`, serverUrl);
      window.location.href = authorizationUrl.toString();
    },
    saveCodeVerifier(codeVerifier) {
      localStorage.setItem(verifierKey(serverId), codeVerifier);
    },
    codeVerifier() {
      const verifier = localStorage.getItem(verifierKey(serverId));
      if (!verifier) {
        throw new Error("OAuth code verifier not found");
      }
      return verifier;
    },
    invalidateCredentials(scope) {
      if (scope === "all" || scope === "client") {
        localStorage.removeItem(clientInfoKey(serverId));
      }
      if (scope === "all" || scope === "tokens") {
        localStorage.removeItem(tokensKey(serverId));
      }
      if (scope === "all" || scope === "verifier") {
        localStorage.removeItem(verifierKey(serverId));
      }
    },
  };
}
