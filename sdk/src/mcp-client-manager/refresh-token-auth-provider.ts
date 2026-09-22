import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/client";

/**
 * Called when the authorization server hands back a refresh token that
 * replaces the one currently held.
 *
 * Rotation is single-use at most authorization servers — WorkOS AuthKit, which
 * fronts MCPJam's own MCP server, is one — so the token a long-lived caller was
 * configured with stops working the moment it is first exchanged. Inside one
 * process that does not matter, because this provider keeps using the newest
 * one. Across processes it matters completely: a CI job configured from a
 * secret gets exactly one successful run, and the second fails to authorize
 * with nothing in the logs to say a credential was silently replaced.
 *
 * This is the only way out. Persist `refreshToken` wherever the value came
 * from, and the next process starts from a token that still works.
 *
 * Errors are swallowed deliberately: a failed write must not break a
 * connection that has already authorized successfully. If persistence has to
 * be reliable, do the work somewhere it can be retried and treat this as the
 * notification it is.
 */
export type RefreshTokensRotatedHandler = (rotated: {
  /** The refresh token to store. Never empty. */
  refreshToken: string;
  /** The token set the authorization server returned, in full. */
  tokens: OAuthTokens;
}) => void | Promise<void>;

export class RefreshTokenOAuthProvider implements OAuthClientProvider {
  private currentRefreshToken: string;
  private currentTokens?: OAuthTokens;

  constructor(
    private readonly _clientId: string,
    refreshToken: string,
    private readonly _clientSecret?: string,
    private readonly _onTokensRotated?: RefreshTokensRotatedHandler
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
    if (!tokens.refresh_token) return;

    // Only a CHANGE is worth reporting. An authorization server that returns
    // the same refresh token every time has rotated nothing, and telling the
    // caller to persist a value it already holds would turn every refresh into
    // a pointless write.
    const rotated = tokens.refresh_token !== this.currentRefreshToken;
    this.currentRefreshToken = tokens.refresh_token;
    if (!rotated || !this._onTokensRotated) return;

    // Fire and forget, and never let it reach the connection. The token is
    // already stored above, so a failed write costs the NEXT process, not this
    // one — and throwing here would fail a connection that just authorized.
    try {
      void Promise.resolve(
        this._onTokensRotated({
          refreshToken: tokens.refresh_token,
          tokens,
        })
      ).catch(() => {});
    } catch {
      /* a handler that threw synchronously is still the caller's problem */
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
