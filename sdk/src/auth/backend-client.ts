import { AuthError, type Credentials, type UserInfo } from "./types.js";

/** Default Convex HTTP base URL — mirrors `CONVEX_HTTP_URL` in `.env.production`. */
export const DEFAULT_BACKEND_BASE_URL =
  "https://outstanding-fennec-304.convex.site";

export interface BackendClientOptions {
  /** Override the base URL. Falls back to `MCPJAM_API_URL` env, then the default. */
  baseUrl?: string;
  credentials: Credentials;
  /** Inject a fetch implementation (tests, electron, undici, etc.). */
  fetchImpl?: typeof fetch;
}

/**
 * Minimal HTTP client used by the CLI and (eventually) the MCP server. The
 * surface is deliberately tiny today — `whoami` only — so we can expand it
 * alongside ingestion commands without a second rewrite.
 */
export class BackendClient {
  readonly baseUrl: string;
  private readonly credentials: Credentials;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BackendClientOptions) {
    this.baseUrl =
      options.baseUrl ??
      process.env.MCPJAM_API_URL ??
      DEFAULT_BACKEND_BASE_URL;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Calls `GET /api/auth/whoami` with the current credentials. Throws an
   * `AuthError` with code `UNAUTHORIZED` on 401 so the CLI can prompt
   * `mcpjam login` again without parsing the body.
   */
  async whoami(): Promise<UserInfo> {
    const res = await this.request("/api/auth/whoami", { method: "GET" });
    if (res.status === 401) {
      throw new AuthError(
        "UNAUTHORIZED",
        "Stored credentials were rejected by the backend. Run `mcpjam login` again.",
      );
    }
    if (!res.ok) {
      throw new AuthError(
        "SERVER",
        `whoami failed with status ${res.status}.`,
        await safeReadText(res),
      );
    }
    return (await res.json()) as UserInfo;
  }

  /** Raw request helper — exposed for future ingestion commands. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = joinUrl(this.baseUrl, path);
    const headers = new Headers(init.headers ?? {});
    const token = bearerTokenFor(this.credentials);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    try {
      return await this.fetchImpl(url, { ...init, headers });
    } catch (err: any) {
      throw new AuthError(
        "NETWORK",
        `Failed to reach ${url}: ${err?.message ?? String(err)}`,
        err,
      );
    }
  }
}

function bearerTokenFor(credentials: Credentials): string | null {
  switch (credentials.kind) {
    case "apiKey":
      return credentials.apiKey;
    case "oauth":
      return credentials.accessToken;
    default:
      return null;
  }
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function safeReadText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}
