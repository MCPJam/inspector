import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export class RefreshTokenOAuthProvider implements OAuthClientProvider {
  private currentRefreshToken: string;
  private currentTokens?: OAuthTokens;

  constructor(
    private readonly _clientId: string,
    refreshToken: string,
    private readonly _clientSecret?: string
  ) {
    this.currentRefreshToken = refreshToken;
  }

  get redirectUrl() {
    return undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { redirect_uris: [], grant_types: ["refresh_token"] };
  }

  clientInformation() {
    return this._clientSecret
      ? { client_id: this._clientId, client_secret: this._clientSecret }
      : { client_id: this._clientId };
  }

  tokens() {
    return this.currentTokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.currentTokens = tokens;
    if (tokens.refresh_token) {
      this.currentRefreshToken = tokens.refresh_token;
    }
  }

  prepareTokenRequest() {
    return new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.currentRefreshToken,
    });
  }

  redirectToAuthorization() {
    throw new Error("Non-interactive OAuth flow");
  }

  saveCodeVerifier() {
    /* no-op */
  }

  codeVerifier(): string {
    throw new Error("Non-interactive OAuth flow");
  }
}
