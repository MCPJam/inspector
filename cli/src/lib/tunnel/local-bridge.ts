/**
 * Local bridge: the HTTP server the relay client replays edge requests
 * against. Binds 127.0.0.1:<ephemeral> and serves exactly the tunnel's
 * path scope, `/api/mcp/adapter-http/<serverId>`:
 *
 *  - HTTP target: transparent streaming reverse proxy. The tunnel prefix is
 *    stripped, the `?k=` bearer secret (forwarded verbatim by the edge) is
 *    dropped, every other path segment and query param is preserved, and
 *    bodies stream both ways — SSE responses are never buffered.
 *  - stdio target: one persistent MCPClientManager child for the bridge
 *    lifetime, fronted by a stateless streamable-HTTP facade. Behavior
 *    parity source: `mcpjam-inspector/server/services/mcp-http-bridge.ts`
 *    (initialize answered locally from the real handshake, notifications →
 *    202, everything else forwarded verbatim through the managed client).
 *    GET/SSE notification streams are out of scope: 405, which
 *    streamable-HTTP clients tolerate.
 *
 * The edge already enforces the per-server path scope; rejecting foreign
 * paths here too is defense-in-depth, not the security boundary.
 */
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { MCPClientManager, type MCPServerConfig } from "@mcpjam/sdk";

export type TunnelTarget =
  | { kind: "http"; url: string }
  | { kind: "stdio"; config: MCPServerConfig };

export interface LocalBridge {
  /** Base address for the relay client, e.g. http://127.0.0.1:51234 */
  localAddr: string;
  close(): Promise<void>;
}

export interface StartLocalBridgeOptions {
  serverId: string;
  target: TunnelTarget;
  /** Connect/request timeout for the stdio child. */
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Test seam: supplies the connected manager for stdio targets. */
  connectStdio?: (
    serverId: string,
    config: MCPServerConfig,
  ) => Promise<MCPClientManager>;
}

export function tunnelPathPrefix(serverId: string): string {
  return `/api/mcp/adapter-http/${encodeURIComponent(serverId)}`;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) plus host: never forwarded by a
// proxy. Node recomputes framing (content-length/transfer-encoding) from
// the actual stream.
const NON_FORWARDED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const NON_FORWARDED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Split an inbound tunnel path into the in-scope remainder, or null when it
 * falls outside this server's scope. The exact base path (no trailing
 * segment) is the public URL shape and must be accepted.
 */
export function matchTunnelPath(
  serverId: string,
  pathname: string,
): string | null {
  const prefix = tunnelPathPrefix(serverId);
  if (pathname === prefix) return "";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return null;
}

/** Drop only the tunnel's `k` bearer param; everything else passes through. */
export function stripTunnelSecret(search: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(search);
  params.delete("k");
  return params;
}

// ── HTTP target: streaming reverse proxy ─────────────────────────────────

function buildUpstreamUrl(
  targetUrl: URL,
  remainderPath: string,
  callerParams: URLSearchParams,
): URL {
  const upstream = new URL(targetUrl.toString());
  const basePath = upstream.pathname.replace(/\/+$/, "");
  upstream.pathname = remainderPath ? `${basePath}${remainderPath}` : upstream.pathname;
  // Target's own query params stay; caller params (minus `k`) are appended.
  for (const [name, value] of callerParams) {
    upstream.searchParams.append(name, value);
  }
  return upstream;
}

function proxyHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamUrl: URL,
): void {
  const requestFn = upstreamUrl.protocol === "https:" ? https.request : http.request;

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || NON_FORWARDED_REQUEST_HEADERS.has(name)) continue;
    headers[name] = value;
  }

  const upstream = requestFn(
    upstreamUrl,
    { method: req.method, headers },
    (upstreamRes) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || NON_FORWARDED_RESPONSE_HEADERS.has(name)) {
          continue;
        }
        responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      // Stream, never buffer: SSE responses flow chunk by chunk.
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    writeJson(res, 502, {
      error: `Local target unreachable: ${error.message}`,
    });
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

// ── stdio target: stateless streamable-HTTP facade ───────────────────────

type JsonRpcBody = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * The facade's JSON-RPC core, factored for tests. Returns the response
 * envelope, or null for notifications (HTTP layer answers 202).
 */
export async function handleFacadeJsonRpc(
  serverId: string,
  body: JsonRpcBody,
  manager: Pick<
    MCPClientManager,
    "getInitializationInfo" | "getManagedClient"
  >,
): Promise<Record<string, unknown> | null> {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params ?? {};

  const respond = (payload: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    ...payload,
  });

  // A missing/non-string method is not a notification — it's an invalid
  // envelope, and a caller waiting on its id would hang on a silent 202.
  if (typeof method !== "string" || method.length === 0) {
    return respond({
      error: { code: -32600, message: "Invalid Request" },
    });
  }

  // notifications/* get no response envelope (the HTTP layer answers 202).
  // notifications/initialized lands here right after initialize; forwarding
  // it as a request would hang every TS-SDK client.
  if (method.startsWith("notifications/")) {
    return null;
  }
  const respondError = (error: unknown) =>
    respond({
      error: {
        code: typeof (error as { code?: unknown })?.code === "number"
          ? (error as { code: number }).code
          : -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });

  try {
    if (method === "ping") {
      return respond({ result: {} });
    }

    if (method === "initialize") {
      // Answer from the real handshake the bridge already performed, so
      // remote clients negotiate against what the child actually supports.
      const info = manager.getInitializationInfo(serverId);
      const requested =
        typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : "2025-06-18";
      const result: Record<string, unknown> = {
        protocolVersion: info?.protocolVersion ?? requested,
        capabilities: info?.serverCapabilities ?? {},
        serverInfo: info?.serverVersion ?? {
          name: serverId,
          version: "mcpjam-tunnel",
        },
      };
      if (info?.instructions !== undefined) {
        result.instructions = info.instructions;
      }
      return respond({ result });
    }

    // Transparent passthrough: tools/list, tools/call, resources/*,
    // prompts/*, completion/complete, future spec methods — the child's own
    // responses, unshaped.
    const managed = manager.getManagedClient(serverId);
    if (!managed) {
      return respond({
        error: {
          code: -32000,
          message: "Local MCP server is not connected (did the process exit?)",
        },
      });
    }
    const result = await managed.request({ method, params });
    return respond({ result: result ?? {} });
  } catch (error) {
    return respondError(error);
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function handleStdioRequest(
  serverId: string,
  manager: MCPClientManager,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== "POST") {
    // No SSE notification stream in the MVP; streamable-HTTP clients treat
    // 405 on GET as "server offers no stream".
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  void (async () => {
    let body: unknown;
    try {
      const raw = await readRequestBody(req);
      body = raw.byteLength > 0 ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (Array.isArray(body)) {
      // JSON-RPC batching was removed in MCP 2025-06-18.
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Batch requests are not supported" },
      });
      return;
    }

    const response = await handleFacadeJsonRpc(
      serverId,
      body as JsonRpcBody,
      manager,
    );
    if (!response) {
      res.writeHead(202);
      res.end("Accepted");
      return;
    }
    writeJson(res, 200, response);
  })().catch(() => {
    if (!res.headersSent) {
      writeJson(res, 500, { error: "Bridge failure" });
    } else {
      res.destroy();
    }
  });
}

// ── Bridge server ────────────────────────────────────────────────────────

export async function startLocalBridge(
  options: StartLocalBridgeOptions,
): Promise<LocalBridge> {
  const { serverId, target } = options;

  let manager: MCPClientManager | null = null;
  if (target.kind === "stdio") {
    if (options.connectStdio) {
      manager = await options.connectStdio(serverId, target.config);
    } else {
      // One persistent child for the tunnel lifetime — deliberately NOT the
      // ephemeral connect-per-call manager the other CLI commands use.
      manager = new MCPClientManager(
        {},
        {
          defaultTimeout: options.timeoutMs ?? 30_000,
          defaultClientName: "mcpjam-tunnel",
          lazyConnect: true,
        },
      );
      await manager.connectToServer(serverId, target.config);
    }
  }

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://bridge.invalid");
    } catch {
      writeJson(res, 400, { error: "Bad request" });
      return;
    }

    const remainder = matchTunnelPath(serverId, url.pathname);
    if (remainder === null) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }
    const callerParams = stripTunnelSecret(url.searchParams);

    if (target.kind === "http") {
      const upstreamUrl = buildUpstreamUrl(
        new URL(target.url),
        remainder,
        callerParams,
      );
      proxyHttpRequest(req, res, upstreamUrl);
      return;
    }

    handleStdioRequest(serverId, manager!, req, res);
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    await manager?.disconnectAllServers().catch(() => {});
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    await manager?.disconnectAllServers().catch(() => {});
    throw new Error("Failed to bind the local bridge address");
  }

  return {
    localAddr: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // In-flight SSE/proxy sockets would otherwise hold close() forever.
        server.closeAllConnections?.();
      });
      if (manager) {
        // Kills the stdio child.
        await manager.disconnectAllServers().catch(() => {});
      }
    },
  };
}
