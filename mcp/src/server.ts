import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { JWTPayload } from "jose";
import {
  createSessionToolRegistrar,
  type SessionToolRegistrar,
} from "./tools/sessionToolRegistrar.js";
import { registerPlatformCatalogTools } from "./tools/platformTools.js";
import { registerShowServersTool } from "./tools/showServers.js";

interface McpProps extends Record<string, unknown> {
  // Optional: an anonymous (tokenless) session carries neither. The bearer is
  // then minted lazily on first platform-tool execution (see getBearerToken).
  bearerToken?: string;
  claims?: JWTPayload;
  // Real client IP for the anonymous connection (set by the edge from
  // cf-connecting-ip), forwarded to the mint route so it can rate-limit per
  // client rather than per worker.
  clientIp?: string;
}

// Re-mint a minted guest token this far before its expiry. A guest token is
// long-lived (~24h) but a long-running anonymous session must not start
// failing every tool call the moment it lapses — refresh ahead of the edge.
const GUEST_TOKEN_REFRESH_SLACK_MS = 60_000;

export class McpJamMcpServer extends McpAgent<Env, unknown, McpProps> {
  private sessionToolRegistrar?: SessionToolRegistrar;
  private mintedGuest?: { token: string; expiresAt: number };
  private mintInFlight?: Promise<string | undefined>;

  server = new McpServer({
    name: "MCPJam MCP",
    version: "0.2.0",
  });

  get runtimeEnv(): Required<Env> {
    return this.env as Required<Env>;
  }

  /** Synchronous view: the verified/minted token if one already exists. */
  get bearerToken(): string | undefined {
    return this.props?.bearerToken ?? this.mintedGuest?.token;
  }

  /**
   * The bearer to authenticate Platform API calls with. For an authed session
   * it's the verified token. For an anonymous session it's a guest token
   * minted lazily on first call (NOT at connect/list_tools — listing tools
   * needs no Platform API, so an anonymous preflight must not create a guest
   * session) and re-minted before it expires, so a long-lived session never
   * starts 401ing on a lapsed guest token. Concurrent calls share one mint; a
   * mint failure surfaces as a tool error (caller checks for undefined) and is
   * retried next call.
   */
  async getBearerToken(): Promise<string | undefined> {
    if (this.props?.bearerToken) return this.props.bearerToken;

    const cached = this.mintedGuest;
    if (cached && cached.expiresAt - Date.now() > GUEST_TOKEN_REFRESH_SLACK_MS) {
      return cached.token;
    }

    // Absent or within the refresh window → (re)mint once, shared across
    // concurrent callers.
    if (!this.mintInFlight) {
      this.mintInFlight = mintGuestToken(this.env, this.props?.clientIp)
        .then((minted) => {
          this.mintedGuest = minted; // undefined on failure → cache untouched
          return minted?.token;
        })
        .catch(() => undefined)
        .finally(() => {
          this.mintInFlight = undefined; // allow refresh/retry next call
        });
    }
    return this.mintInFlight;
  }

  async init(): Promise<void> {
    const initializeRequest = await this.getInitializeRequest();
    const initializeClientCapabilities = (initializeRequest as
      | { params?: { capabilities?: ClientCapabilities } }
      | undefined)?.params?.capabilities;
    const registrar = createSessionToolRegistrar(
      this.server,
      uiSupportsResourceMime(initializeClientCapabilities)
    );
    this.sessionToolRegistrar = registrar;

    registerShowServersTool(registrar, this);
    registerPlatformCatalogTools(registrar, this);
  }

  override async onConnect(conn: any, context: { request: Request }): Promise<void> {
    this.applyUiModeFromRawRequest(context.request);
    await super.onConnect(conn, context as any);
  }

  private applyUiModeFromRawRequest(request: Request): void {
    if (
      !this.sessionToolRegistrar ||
      this.getTransportType() !== "streamable-http" ||
      request.headers.get("cf-mcp-method") !== "POST"
    ) {
      return;
    }

    const payloadHeader = request.headers.get("cf-mcp-message");
    if (!payloadHeader) {
      return;
    }

    try {
      const rawPayload = Buffer.from(payloadHeader, "base64").toString("utf-8");
      const parsedBody = JSON.parse(rawPayload) as unknown;
      const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];

      for (const message of messages) {
        const clientCapabilities = getInitializeCapabilities(message);
        if (!clientCapabilities) {
          continue;
        }

        this.sessionToolRegistrar.setUiEnabled(
          uiSupportsResourceMime(clientCapabilities),
          { notify: false }
        );
        return;
      }
    } catch {
      // Ignore malformed headers and let the transport surface the real error.
    }
  }
}

/**
 * Mint a fresh guest token via the inspector's service-token-gated route
 * (`MCPJAM_GUEST_MINT_URL`). The route mints through the same Convex authority
 * that publishes the guest JWKS the worker verifies against, so the token is
 * accepted on the way back in. The client IP is forwarded in a custom header
 * (cf-connecting-ip would be overwritten by Cloudflare on the worker→inspector
 * hop) so the route can rate-limit per client. Returns the token and its
 * expiry (ms epoch) so the session can refresh before it lapses; returns
 * undefined on any failure (the caller turns that into a tool error).
 */
async function mintGuestToken(
  env: Env,
  clientIp: string | undefined
): Promise<{ token: string; expiresAt: number } | undefined> {
  const url = env.MCPJAM_GUEST_MINT_URL;
  const serviceToken = env.MCPJAM_INSPECTOR_SERVICE_TOKEN;
  if (!url || !serviceToken) return undefined;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-inspector-service-token": serviceToken,
    };
    if (clientIp) headers["x-mcpjam-client-ip"] = clientIp;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      token?: unknown;
      expiresAt?: unknown;
    };
    if (typeof data.token !== "string") return undefined;
    return { token: data.token, expiresAt: normalizeExpiry(data.expiresAt) };
  } catch {
    return undefined;
  }
}

/**
 * Normalize a mint `expiresAt` to ms epoch. The mint contract is ms (matches
 * `issueGuestToken`), but tolerate a seconds value defensively. A missing or
 * non-positive value falls back to a short TTL so the next call re-mints
 * rather than caching a never-expiring token forever.
 */
function normalizeExpiry(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return Date.now() + GUEST_TOKEN_REFRESH_SLACK_MS;
  }
  // Seconds-epoch timestamps are < 1e12; ms-epoch are ~1.7e12 today.
  return raw < 1e12 ? raw * 1000 : raw;
}

function uiSupportsResourceMime(
  clientCapabilities: ClientCapabilities | undefined
): boolean {
  return (
    getUiCapability(clientCapabilities)?.mimeTypes?.includes(
      RESOURCE_MIME_TYPE
    ) ?? false
  );
}

function getUiCapability(
  clientCapabilities:
    | (ClientCapabilities & { extensions?: Record<string, unknown> })
    | undefined
): { mimeTypes?: string[] } | undefined {
  return clientCapabilities?.extensions?.["io.modelcontextprotocol/ui"] as
    | { mimeTypes?: string[] }
    | undefined;
}

function getInitializeCapabilities(
  message: unknown
): ClientCapabilities | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const initializeMessage = message as {
    method?: unknown;
    params?: { capabilities?: ClientCapabilities };
  };

  return initializeMessage.method === "initialize"
    ? initializeMessage.params?.capabilities
    : undefined;
}
