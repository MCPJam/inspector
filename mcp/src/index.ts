import { McpJamMcpServer } from "./server.js";
import {
  GUEST_ISSUER,
  OAUTH_DISCOVERY_HEADERS,
  normalizeIssuer,
  verifyBearerToken,
  type VerifyConfig,
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
    // The token's `aud` and the issuer→JWKS allow-list are both keyed on the
    // WorkOS client id (public — also shipped to the browser as
    // VITE_WORKOS_CLIENT_ID), so the worker must know it to verify forwarded
    // AuthKit tokens. See `authkitIssuerJwks` in auth.ts.
    const clientId = env.WORKOS_CLIENT_ID;
    if (!clientId) {
      return new Response("Server misconfigured: WORKOS_CLIENT_ID is not set", {
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
      const upstreamUrl = new URL(
        "/.well-known/oauth-authorization-server",
        issuer,
      );
      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl);
      } catch {
        return Response.json(
          { error: "Authorization server discovery unavailable" },
          { status: 502, headers: OAUTH_DISCOVERY_HEADERS },
        );
      }
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

      // Killswitch: when locked down, the server is AuthKit-only — guest
      // tokens are not accepted and anonymous (tokenless) connections are
      // refused with the normal 401 → OAuth challenge.
      const lockedDown = env.MCPJAM_NONPROD_LOCKDOWN === "true";

      // Guest verification is enabled only when a guest JWKS URL is configured
      // (and not locked down). Absent it, guest tokens fall through to the
      // AuthKit allow-list and are rejected.
      const guest: VerifyConfig["guest"] =
        !lockedDown && env.MCPJAM_GUEST_JWKS_URL
          ? { issuer: GUEST_ISSUER, jwksUrl: env.MCPJAM_GUEST_JWKS_URL }
          : undefined;

      let props: { bearerToken?: string; claims?: unknown; clientIp?: string };
      if (request.headers.has("authorization")) {
        // A bearer was presented → it must verify (AuthKit or guest). A
        // present-but-invalid token still 401s; we never downgrade it to an
        // anonymous guest.
        const result = await verifyBearerToken(
          request,
          { clientId, authkitDomain: env.AUTHKIT_DOMAIN, guest },
          origin,
        );
        if (!result.ok) return result.response;
        props = {
          bearerToken: result.verified.token,
          claims: result.verified.payload,
        };
      } else if (lockedDown) {
        // Tokenless + locked down → preserve the 401 → OAuth challenge.
        const result = await verifyBearerToken(
          request,
          { clientId, authkitDomain: env.AUTHKIT_DOMAIN },
          origin,
        );
        // verifyBearerToken returns the 401 missing-token response here.
        if (!result.ok) return result.response;
        props = {
          bearerToken: result.verified.token,
          claims: result.verified.payload,
        };
      } else {
        // Tokenless anonymous session: NO mint here. The Durable Object mints
        // a guest token lazily on first platform-tool execution. Capture the
        // edge-provided client IP (trustworthy here — set by Cloudflare on the
        // inbound hit) so the DO can forward it to the rate-limited mint route.
        props = {
          bearerToken: undefined,
          claims: undefined,
          clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
        };
      }

      const authedCtx: ExecutionContext<Record<string, unknown>> = {
        waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
        passThroughOnException: () => ctx.passThroughOnException(),
        props,
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
