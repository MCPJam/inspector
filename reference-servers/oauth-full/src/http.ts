import http from "node:http";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import { CaptureSession } from "./capture.js";
import { PREREGISTERED_CLIENT_ID, PREREGISTERED_CLIENT_SECRET, type ReferenceServerConfig } from "./config.js";
import { createReferenceMcpServer } from "./mcp.js";
import {
  authorizationServerMetadata,
  createOAuthContext,
  handleAuthorize,
  handleConsent,
  handleRegister,
  handleToken,
  escapeHtml,
  protectedResourceMetadata,
  readBody,
  sendHtml,
  sendJson,
  type OAuthContext,
} from "./oauth.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, Last-Event-ID",
  "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
};

interface McpSession {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
}

export interface ReferenceServer {
  httpServer: http.Server;
  ctx: OAuthContext;
  currentCapture: () => CaptureSession;
  close: () => Promise<void>;
}

export function createReferenceServer(config: ReferenceServerConfig): ReferenceServer {
  let capture = new CaptureSession(config.label, config);
  const captureRef = () => capture;
  const ctx = createOAuthContext(config, captureRef);
  const sessions = new Map<string, McpSession>();

  const allowedHosts = new Set<string>(["localhost", "127.0.0.1", "::1", "[::1]"]);
  try {
    allowedHosts.add(new URL(config.publicUrl).hostname.toLowerCase());
  } catch {
    // publicUrl is validated at startup; ignore here.
  }

  const isAllowedHost = (req: http.IncomingMessage): boolean => {
    const raw = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    if (!raw) return true;
    try {
      return allowedHosts.has(new URL(`http://${raw}`).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  const wwwAuthenticate = (error?: string) =>
    [
      `Bearer realm="mcpjam-oauth-reference"`,
      error ? `error="${error}"` : undefined,
      `resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
      `scope="mcp:tools mcp:resources mcp:prompts"`,
    ]
      .filter(Boolean)
      .join(", ");

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", config.publicUrl);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (!isAllowedHost(req)) {
      sendJson(res, 403, { error: "forbidden_host", detail: "Host header not in the allowed set; pass --public-url" });
      return;
    }

    try {
      // ---- discovery ------------------------------------------------------
      if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
        capture.record({
          kind: "prm_discovery",
          method,
          path,
          status: 200,
          userAgent: req.headers["user-agent"],
        });
        sendJson(res, 200, protectedResourceMetadata(ctx), CORS_HEADERS);
        return;
      }
      if (
        method === "GET" &&
        (path.startsWith("/.well-known/oauth-authorization-server") ||
          path.startsWith("/.well-known/openid-configuration"))
      ) {
        capture.record({
          kind: "as_metadata_discovery",
          method,
          path,
          status: 200,
          userAgent: req.headers["user-agent"],
        });
        sendJson(res, 200, authorizationServerMetadata(ctx), CORS_HEADERS);
        return;
      }

      // ---- authorization server --------------------------------------------
      if (path === "/authorize" && method === "GET") {
        await handleAuthorize(ctx, req, res, url);
        return;
      }
      if (path === "/authorize/consent" && method === "POST") {
        await handleConsent(ctx, req, res);
        return;
      }
      if (path === "/token" && method === "POST") {
        await handleToken(ctx, req, res);
        return;
      }
      if (path === "/register" && method === "POST") {
        await handleRegister(ctx, req, res);
        return;
      }

      // ---- capture control --------------------------------------------------
      if (path === "/capture/report" && method === "GET") {
        sendJson(res, 200, capture.buildReport());
        return;
      }
      if (path === "/capture/reset" && method === "POST") {
        const body = await readBody(req);
        let label = capture.label;
        try {
          const parsed = JSON.parse(body || "{}");
          if (typeof parsed.label === "string" && parsed.label.trim()) label = parsed.label.trim();
        } catch {
          // keep previous label
        }
        const flushed = capture.eventCount() > 0 ? capture.flush() : undefined;
        capture = new CaptureSession(label, config);
        sendJson(res, 200, { ok: true, label, previousReportFile: flushed ?? null });
        return;
      }
      if (path === "/capture/flush" && method === "POST") {
        sendJson(res, 200, { ok: true, file: capture.flush() });
        return;
      }

      // ---- MCP (bearer-gated) ------------------------------------------------
      if (path === "/mcp") {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
          capture.record({
            kind: "mcp_unauthenticated",
            method,
            path,
            status: 401,
            userAgent: req.headers["user-agent"],
            detail: { hadAuthorizationHeader: Boolean(authHeader) },
          });
          sendJson(res, 401, { error: "unauthorized" }, { ...CORS_HEADERS, "WWW-Authenticate": wwwAuthenticate() });
          return;
        }
        const lookup = ctx.store.lookupAccessToken(authHeader.slice(7));
        if (!lookup.token) {
          capture.record({
            kind: "mcp_invalid_token",
            method,
            path,
            status: 401,
            userAgent: req.headers["user-agent"],
            detail: { reason: lookup.reason },
          });
          sendJson(
            res,
            401,
            { error: "invalid_token", error_description: `access token is ${lookup.reason}` },
            { ...CORS_HEADERS, "WWW-Authenticate": wwwAuthenticate("invalid_token") },
          );
          return;
        }

        for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
        await handleMcp(req, res, lookup.token);
        return;
      }

      // ---- landing page ------------------------------------------------------
      if (path === "/" && method === "GET") {
        sendHtml(res, 200, landingPage(config, capture));
        return;
      }

      sendJson(res, 404, { error: "not_found", path });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  async function handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: NonNullable<ReturnType<typeof ctx.store.lookupAccessToken>["token"]>,
  ): Promise<void> {
    const rawSession = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;

    if (req.method === "POST") {
      const bodyText = await readBody(req);
      let body: unknown;
      try {
        body = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      const rpcMethod =
        body && typeof body === "object" && typeof (body as { method?: unknown }).method === "string"
          ? ((body as { method: string }).method)
          : undefined;
      if (rpcMethod) {
        capture.record({
          kind: "mcp_request",
          method: "POST",
          path: "/mcp",
          status: 200,
          userAgent: req.headers["user-agent"],
          detail: { rpcMethod, clientId: token.clientId },
        });
      }

      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && rpcMethod === "initialize") {
        const server = createReferenceMcpServer(token, captureRef);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        sendJson(res, 400, { error: "invalid_session" });
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  }

  return {
    httpServer,
    ctx,
    currentCapture: captureRef,
    close: async () => {
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function landingPage(config: ReferenceServerConfig, capture: CaptureSession): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>MCPJam OAuth reference server</title></head>
<body style="font-family:system-ui;max-width:44rem;margin:3rem auto;line-height:1.5">
<h1>MCPJam OAuth reference server (HP-10)</h1>
<p>Current capture label: <b>${escapeHtml(capture.label)}</b> — ${capture.eventCount()} events recorded.</p>
<ul>
  <li>MCP endpoint (OAuth-gated): <code>${config.publicUrl}/mcp</code></li>
  <li>Protected resource metadata: <code>/.well-known/oauth-protected-resource/mcp</code></li>
  <li>AS metadata: <code>/.well-known/oauth-authorization-server</code> · OIDC: <code>/.well-known/openid-configuration</code></li>
  <li>DCR: <code>POST /register</code> ${config.dcr ? "(enabled)" : "(disabled)"} · CIMD client_ids accepted</li>
  <li>Preregistered client: <code>${PREREGISTERED_CLIENT_ID}</code> / <code>${PREREGISTERED_CLIENT_SECRET}</code></li>
  <li>Capture: <code>GET /capture/report</code> · <code>POST /capture/reset {"label":"&lt;client&gt;"}</code> · <code>POST /capture/flush</code></li>
</ul>
<p>Point the client under test at <code>${config.publicUrl}/mcp</code>, complete OAuth, exercise tools/resources/prompts, then flush the capture.</p>
</body></html>`;
}
