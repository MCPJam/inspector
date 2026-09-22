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
 * configured with stops working the moment it is first exchanged. For the life
 * of the connection that does not matter, because this provider keeps using
 * the newest one. Beyond it matters completely: a CI job configured from a
 * secret gets exactly one successful run, and the second fails to authorize
 * with nothing in the logs to say a credential was silently replaced.
 *
 * This is the only way out. Persist `refreshToken` wherever the value came
 * from, and the next run starts from a token that still works.
 *
 * The handler is awaited before the connection completes, so a job that exits
 * as soon as it is done still gets the write. Keep it bounded: one that never
 * settles stalls the connection.
 *
 * Errors are swallowed deliberately: a failed write must not break a
 * connection that has already authorized successfully. Nothing is logged
 * either, so a handler that needs its failure recorded has to record it
 * itself, somewhere the write can be retried.
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

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.currentTokens = tokens;
    if (!tokens.refresh_token) return;

    // Only a CHANGE is worth reporting. An authorization server that returns
    // the same refresh token every time has rotated nothing, and telling the
    // caller to persist a value it already holds would turn every refresh into
    // a pointless write.
    const rotated = tokens.refresh_token !== this.currentRefreshToken;
    this.currentRefreshToken = tokens.refresh_token;
    if (!rotated || !this._onTokensRotated) return;

    // AWAITED, not fire-and-forget. `auth()` awaits `saveTokens`, so the
    // connection waits for the write — and a detached write would lose the
    // race with `process.exit`, which is how a short CI job ends and exactly
    // the failure this hook exists to prevent. Awaiting also orders repeated
    // rotations, so the last value written is the newest one.
    try {
      await this._onTokensRotated({
        refreshToken: tokens.refresh_token,
        // A copy: a handler must not be able to mutate the token set this
        // provider is still holding.
        tokens: { ...tokens },
      });
    } catch {
      // Swallowed on purpose: the token is already stored above, so a failed
      // write costs the NEXT run, not the connection that just authorized.
      // Nothing is logged — the handler is the only place that knows how.
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
