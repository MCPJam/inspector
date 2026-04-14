/**
 * Auth primitives shared by the `@mcpjam/cli` and any future MCPJam clients
 * (e.g. MCP servers). The credential surface is a discriminated union so we
 * can add OAuth later without touching API-key callers.
 */

/** Identity payload returned by `GET /api/auth/whoami`. */
export interface UserInfo {
  userId: string;
  email: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  keyPrefix?: string;
}

/** Long-lived workspace/user API key minted via the inspector web UI. */
export interface ApiKeyCredentials {
  kind: "apiKey";
  /** Full `mcpjam_<prefix>_<secret>` token. */
  apiKey: string;
  /** Snapshot of identity at login time; refreshed on `whoami`. */
  user: UserInfo;
  /** Unix ms when this credential was written locally. */
  createdAt: number;
}

/**
 * Placeholder for future MCP-server OAuth flow. The shape is fixed here so
 * `BackendClient` / `getCredentials` already know how to branch when it
 * lands — nothing in the API-key path needs to change then.
 */
export interface OAuthCredentials {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  /** Unix ms at which the access token expires. */
  expiresAt: number;
  user?: UserInfo;
  createdAt: number;
}

export type Credentials = ApiKeyCredentials | OAuthCredentials;

/** Options accepted by `loginWithBrowser`. */
export interface LoginOptions {
  /**
   * Inspector web app base URL — e.g. `https://app.mcpjam.com`. The login
   * handshake page lives at `${webBaseUrl}/cli-auth`.
   */
  webBaseUrl: string;
  /**
   * Convex HTTP base URL used for post-login `whoami` verification —
   * e.g. `https://outstanding-fennec-304.convex.site`.
   */
  apiBaseUrl: string;
  /** Profile name to store credentials under. Defaults to `"default"`. */
  profile?: string;
  /**
   * Override the browser-launcher. In headless mode the CLI passes a function
   * that prints the URL instead of spawning a browser.
   */
  openUrl?: (url: string) => Promise<void> | void;
  /**
   * Called with the resolved login URL before we spawn the browser. Lets the
   * CLI print `Visit: <url>` + a message while we wait for the callback.
   */
  onPrompt?: (info: { url: string; port: number; state: string }) => void;
  /** Override the 5-minute default (ms). */
  timeoutMs?: number;
  /** CLI version string (stamped into the web URL for analytics/UA). */
  clientVersion?: string;
  /**
   * Passed as `?display=code` so the web page renders a copyable key instead
   * of POSTing to the loopback server. The caller is responsible for reading
   * the pasted key from stdin.
   */
  displayMode?: "browser" | "code";
}

/** Returned by `loginWithBrowser` on success. */
export interface LoginResult {
  profile: string;
  credentials: Credentials;
}

/** Errors thrown by this module share a stable `code` so the CLI can branch. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly details?: unknown;

  constructor(code: AuthErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.details = details;
  }
}

export type AuthErrorCode =
  | "UNAUTHORIZED"
  | "TIMEOUT"
  | "STATE_MISMATCH"
  | "USER_CANCELLED"
  | "INVALID_CONFIG"
  | "NETWORK"
  | "SERVER";
