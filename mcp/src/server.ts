import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { JWTPayload } from "jose";
import {
  createSessionToolRegistrar,
  type SessionToolRegistrar,
} from "./tools/sessionToolRegistrar.js";
import { registerShowServersTool } from "./tools/showServers.js";

interface McpProps extends Record<string, unknown> {
  bearerToken: string;
  claims: JWTPayload;
}

export class McpJamMcpServer extends McpAgent<Env, unknown, McpProps> {
  private sessionToolRegistrar?: SessionToolRegistrar;

  server = new McpServer({
    name: "MCPJam MCP",
    version: "0.1.0",
  });

  get runtimeEnv(): Required<Env> {
    return this.env as Required<Env>;
  }

  get bearerToken(): string | undefined {
    return this.props?.bearerToken;
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
