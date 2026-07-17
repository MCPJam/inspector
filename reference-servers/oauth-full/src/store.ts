import { randomBytes } from "node:crypto";

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  source: "dcr" | "cimd" | "preregistered";
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
  grantTypes?: string[];
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  used: boolean;
}

export interface AccessToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  grant: "authorization_code" | "refresh_token" | "jwt-bearer";
}

export interface RefreshToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  /** Rotated-out tokens stay in the store, flagged, so reuse is detectable. */
  rotated: boolean;
}

const id = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

export class OAuthStore {
  readonly clients = new Map<string, RegisteredClient>();
  readonly codes = new Map<string, AuthorizationCode>();
  readonly accessTokens = new Map<string, AccessToken>();
  readonly refreshTokens = new Map<string, RefreshToken>();

  registerClient(client: Omit<RegisteredClient, "clientId"> & { clientId?: string }): RegisteredClient {
    const full: RegisteredClient = {
      ...client,
      clientId: client.clientId ?? id("oauth-ref-client"),
    };
    this.clients.set(full.clientId, full);
    return full;
  }

  issueCode(params: Omit<AuthorizationCode, "code" | "used">): AuthorizationCode {
    const code: AuthorizationCode = { ...params, code: id("code"), used: false };
    this.codes.set(code.code, code);
    return code;
  }

  issueAccessToken(params: Omit<AccessToken, "token">): AccessToken {
    const token: AccessToken = { ...params, token: id("ref_at") };
    this.accessTokens.set(token.token, token);
    return token;
  }

  issueRefreshToken(params: Omit<RefreshToken, "token" | "rotated">): RefreshToken {
    const token: RefreshToken = { ...params, token: id("ref_rt"), rotated: false };
    this.refreshTokens.set(token.token, token);
    return token;
  }

  /** Returns the live token or an expiry/miss reason. */
  lookupAccessToken(raw: string): { token?: AccessToken; reason?: "unknown" | "expired" } {
    const token = this.accessTokens.get(raw);
    if (!token) return { reason: "unknown" };
    if (Date.now() > token.expiresAt) return { reason: "expired" };
    return { token };
  }
}
