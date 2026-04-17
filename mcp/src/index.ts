import { McpJamMcpServer } from "./server.js";
import {
  OAUTH_DISCOVERY_HEADERS,
  normalizeIssuer,
  verifyBearerToken,
} from "./auth.js";

export { McpJamMcpServer };

const LANDING_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCPJam MCP</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
    </style>
  </head>
  <body>
    <h1>MCPJam MCP</h1>
    <p>This is the MCPJam remote MCP server. Connect an MCP client to <code>/mcp</code>.</p>
    <p>Source: <a href="https://github.com/MCPJam/inspector">github.com/MCPJam/inspector</a></p>
  </body>
</html>
`;

function protectedResourceMetadata(origin: string, issuer: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    const issuer = normalizeIssuer(env.AUTHKIT_DOMAIN);
    if (!issuer) {
      return new Response("Server misconfigured: AUTHKIT_DOMAIN is not set", {
        status: 500,
      });
    }

    const isWellKnown = url.pathname.startsWith("/.well-known/");
    if (isWellKnown && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...OAUTH_DISCOVERY_HEADERS,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource")
    ) {
      return Response.json(protectedResourceMetadata(origin, issuer), {
        headers: OAUTH_DISCOVERY_HEADERS,
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      const upstream = await fetch(
        `${issuer}/.well-known/oauth-authorization-server`,
      );
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...OAUTH_DISCOVERY_HEADERS,
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        },
      });
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") {
        return McpJamMcpServer.serve("/mcp").fetch(request, env, ctx);
      }

      const result = await verifyBearerToken(request, issuer, origin);
      if (!result.ok) return result.response;

      const authedCtx: ExecutionContext<Record<string, unknown>> = {
        waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
        passThroughOnException: () => ctx.passThroughOnException(),
        props: {
          bearerToken: result.verified.token,
          claims: result.verified.payload,
        },
      };

      return McpJamMcpServer.serve("/mcp").fetch(request, env, authedCtx);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(LANDING_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
