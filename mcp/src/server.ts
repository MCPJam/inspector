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

export class McpJamMcpServer extends McpAgent<Env, unknown, McpProps> {
  private sessionToolRegistrar?: SessionToolRegistrar;
  private mintedGuestToken?: string;
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
    return this.props?.bearerToken ?? this.mintedGuestToken;
  }

  /**
   * The bearer to authenticate Platform API calls with. For an authed session
   * it's the verified token. For an anonymous session it's a guest token
   * minted lazily on first call (NOT at connect/list_tools — listing tools
   * needs no Platform API, so an anonymous preflight must not create a guest
   * session). Concurrent first calls share one mint; a mint failure surfaces
   * as a tool error (caller checks for undefined) and is retried next call.
   */
  async getBearerToken(): Promise<string | undefined> {
    if (this.props?.bearerToken) return this.props.bearerToken;
    if (this.mintedGuestToken) return this.mintedGuestToken;
    if (!this.mintInFlight) {
      this.mintInFlight = mintGuestToken(this.env, this.props?.clientIp)
        .then((token) => {
          this.mintedGuestToken = token;
          if (!token) this.mintInFlight = undefined; // allow retry on failure
          return token;
        })
        .catch(() => {
          this.mintInFlight = undefined;
          return undefined;
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
 * hop) so the route can rate-limit per client. Returns undefined on any
 * failure; the caller turns that into a tool error.
 */
async function mintGuestToken(
  env: Env,
  clientIp: string | undefined
): Promise<string | undefined> {
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
    const data = (await response.json()) as { token?: unknown };
    return typeof data.token === "string" ? data.token : undefined;
  } catch {
    return undefined;
  }
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
