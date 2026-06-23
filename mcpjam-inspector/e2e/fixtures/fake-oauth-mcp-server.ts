import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface FakeOAuthMcpServer {
  origin: string;
  serverUrl: string;
  requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    body?: unknown;
  }>;
  close: () => Promise<void>;
}

const ACCESS_TOKEN = "e2e-access-token";
const REFRESH_TOKEN = "e2e-refresh-token";
const CLIENT_ID = "e2e-client-id";
const AUTH_CODE = "e2e-auth-code";

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendRedirect(response: ServerResponse, location: string) {
  response.writeHead(302, {
    Location: location,
    "Access-Control-Allow-Origin": "*",
  });
  response.end();
}

function parseBody(rawBody: string, contentType: string | undefined): unknown {
  if (!rawBody) return undefined;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody).entries());
  }
  return rawBody;
}

export async function startFakeOAuthMcpServer(): Promise<FakeOAuthMcpServer> {
  const requests: FakeOAuthMcpServer["requests"] = [];

  const server = http.createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const host = request.headers.host;
      const origin = `http://${host}`;
      const url = new URL(request.url ?? "/", origin);
      const rawBody = await readRequestBody(request);
      const parsedBody = parseBody(rawBody, request.headers["content-type"]);

      requests.push({
        method: request.method ?? "GET",
        path: url.pathname,
        authorization: request.headers.authorization,
        body: parsedBody,
      });

      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
        });
        response.end();
        return;
      }

      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
          sendJson(
            response,
            401,
            {
              error: "missing_token",
            },
            {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            }
          );
          return;
        }

        sendJson(response, 200, {
          jsonrpc: "2.0",
          id:
            typeof parsedBody === "object" && parsedBody
              ? (parsedBody as { id?: unknown }).id
              : 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "fake-oauth-mcp",
              version: "0.0.0",
            },
          },
        });
        return;
      }

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        sendJson(response, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["openid", "profile", "email"],
        });
        return;
      }

      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration"
      ) {
        sendJson(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email"],
        });
        return;
      }

      if (url.pathname === "/register") {
        const body =
          typeof parsedBody === "object" && parsedBody
            ? (parsedBody as Record<string, unknown>)
            : {};
        sendJson(response, 201, {
          client_id: CLIENT_ID,
          token_endpoint_auth_method: "none",
          redirect_uris: body.redirect_uris ?? [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: body.client_name ?? "MCPJam OAuth Debugger E2E",
        });
        return;
      }

      if (url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        if (!redirectUri) {
          sendJson(response, 400, { error: "missing_redirect_uri" });
          return;
        }

        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set("code", AUTH_CODE);
        if (state) {
          callbackUrl.searchParams.set("state", state);
        }
        sendRedirect(response, callbackUrl.toString());
        return;
      }

      if (url.pathname === "/token") {
        sendJson(response, 200, {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    }
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake OAuth MCP server did not receive a TCP address");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    serverUrl: `${origin}/mcp`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
