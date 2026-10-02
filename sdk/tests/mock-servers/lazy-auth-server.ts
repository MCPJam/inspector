/**
 * Lazy-authentication ("mid-session sign-in") MCP fixture.
 *
 * A real `node:http` MCP server on a loopback port that lets a client
 * `initialize`, list everything, and call public tools WITHOUT a token, and
 * refuses only the protected operations — in one of the shapes real hosts and
 * servers use to ask for sign-in:
 *
 * - Claude-style: the HTTP request itself fails with `401` (or `403` for a
 *   step-up) and a `WWW-Authenticate: Bearer ...` challenge, before any MCP
 *   handling (the `http*` and `prm-pointer-only` modes).
 * - ChatGPT-style: a `200` tool result with `isError: true` and the challenge
 *   in `_meta["mcp/www_authenticate"]`, for tools that declare
 *   `securitySchemes` (the `meta*` modes).
 *
 * The same origin also hosts a toy OAuth 2.1 authorization server (RFC 8414
 * metadata, RFC 7591 DCR, Client ID Metadata Documents, PKCE S256, RFC 8707
 * resource indicators, RFC 9207 `iss`) and the RFC 9728 Protected Resource
 * Metadata, so a client can run the whole sign-in flow against it.
 *
 * MCP JSON-RPC is implemented BY HAND rather than through
 * `@modelcontextprotocol/server`: the auth gate has to decide the HTTP status
 * of a request before any SDK sees it, and the `_meta` challenge shapes are not
 * something a conforming framework emits on request.
 *
 * Transports:
 * - `streamable-http` (default): `POST /mcp` answers `application/json`;
 *   `GET /mcp` is `405`. Serves both protocol eras: the 2025 `initialize`
 *   handshake and the stateless 2026-07-28 era (`server/discover` + per-request
 *   `_meta` envelope), so an `MCPClientManager` connects unpinned (auto
 *   negotiation lands on 2026-07-28) and pinned to either era.
 * - `sse` (legacy HTTP+SSE): `GET /sse` opens the stream and sends the
 *   `endpoint` event; `POST /messages?sessionId=...` answers `202` and delivers
 *   the JSON-RPC response on the stream. The auth gate applies to the POST: a
 *   `401`/`403` is the HTTP status of the POST itself, exactly as on
 *   Streamable HTTP. Legacy-era only (`server/discover` is `-32601`, which is
 *   what a real HTTP+SSE server answers).
 *
 * All state is in memory; nothing here imports vitest, so the CLI's
 * `node:test` suites can import it through tsx as well.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readJsonRpcBody, requestId } from "../support/json-rpc-fixture.js";

// ---------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------

/**
 * How the server refuses a protected operation made without a valid token.
 * See `missingTokenDenial` for the exact bytes of each.
 */
export type LazyAuthMode =
  | "http401"
  | "http401-bare"
  | "http401-noheader"
  | "http401-no-rm"
  | "prm-pointer-only"
  | "http403-noscope"
  | "meta"
  | "meta-string"
  | "meta-inherited-default"
  | "meta-no-default"
  | "meta-no-error-description"
  | "none";

/** Every mode, for `it.each` tables. */
export const LAZY_AUTH_MODES: readonly LazyAuthMode[] = [
  "http401",
  "http401-bare",
  "http401-noheader",
  "http401-no-rm",
  "prm-pointer-only",
  "http403-noscope",
  "meta",
  "meta-string",
  "meta-inherited-default",
  "meta-no-default",
  "meta-no-error-description",
  "none",
];

export type LazyAuthTransport = "streamable-http" | "sse";

export const ORDERS_READ_SCOPE = "orders:read";
export const ORDERS_WRITE_SCOPE = "orders:write";
/** `scopes_supported` of the protected resource (no `offline_access`). */
export const LAZY_AUTH_RESOURCE_SCOPES = [
  ORDERS_READ_SCOPE,
  ORDERS_WRITE_SCOPE,
];

/** The `_meta` key a ChatGPT-style server puts its challenge under. */
export const META_WWW_AUTHENTICATE_KEY = "mcp/www_authenticate";
/**
 * JSON-RPC error code for a protected resource/prompt refused in a `meta*`
 * mode. Fixture-specific (implementation-defined server error range): reads
 * and prompts have no `_meta` channel for a challenge.
 */
export const AUTH_REQUIRED_RPC_ERROR_CODE = -32001;
/** The only path that serves PRM in `prm-pointer-only` mode. */
export const PRM_POINTER_PATH = "/meta/protected-resource.json";

export const PUBLIC_RESOURCE_URI = "catalog://products";
export const PROTECTED_RESOURCE_URI = "orders://recent";
export const PUBLIC_PROMPT_NAME = "product_pitch";
export const PROTECTED_PROMPT_NAME = "order_summary";

/** One logged HTTP request. Never carries a raw token. */
export interface LazyAuthRequestLog {
  /** HTTP method. */
  method: string;
  /** Path without the query string. */
  path: string;
  /** HTTP status the fixture answered with (`0` until headers are written). */
  status: number;
  /** JSON-RPC method of an MCP POST. */
  rpcMethod?: string;
  /** `params.name` of a `tools/call`. */
  toolName?: string;
  /** `params.uri` of a `resources/read`. */
  resourceUri?: string;
  /** `params.name` of a `prompts/get`. */
  promptName?: string;
  /**
   * {@link hashToken} of the `Authorization: Bearer` token, when one was sent.
   * Lets a test assert WHICH token reached the server without logging it.
   */
  tokenHash?: string;
  /** Non-secret OAuth parameters of an `/authorize`, `/token` or `/register` call. */
  oauth?: {
    clientId?: string;
    grantType?: string;
    responseType?: string;
    redirectUri?: string;
    scope?: string;
    resource?: string;
  };
}

export interface LazyAuthServerOptions {
  mode: LazyAuthMode;
  transport?: LazyAuthTransport;
  /** Interface to bind; defaults to `127.0.0.1`. */
  host?: string;
  /** Lifetime of issued access tokens in seconds. Defaults to 3600. */
  accessTokenTtlSeconds?: number;
}

export interface LazyAuthServer {
  /**
   * The URL a client connects to: `<origin>/mcp` for Streamable HTTP,
   * `<origin>/sse` for legacy HTTP+SSE. Also the PRM `resource`.
   */
  url: string;
  /** `http://host:port` — the issuer and the PRM's authorization server. */
  origin: string;
  mode: LazyAuthMode;
  transport: LazyAuthTransport;
  /** The URL the challenges point at (`resource_metadata`). */
  resourceMetadataUrl: string;
  /** Every request, in arrival order. */
  requests: LazyAuthRequestLog[];
  /**
   * A valid access token bound to this server's resource, without running the
   * flow. `expiresInSeconds <= 0` mints an already-expired token.
   */
  mintAccessToken(
    scopes: string[],
    options?: { expiresInSeconds?: number }
  ): string;
  /**
   * Programmatic "click Allow": GET the authorize URL, POST the consent form,
   * and return the redirect `Location` (with `code`, `state`, `iss`) without
   * following it. If the authorize request itself is redirected back with an
   * error (e.g. missing PKCE), that error redirect is returned instead; if it
   * is refused outright (unknown client, unregistered redirect URI), this
   * throws.
   */
  approveAuthorization(authorizeUrl: string): Promise<string>;
  close(): Promise<void>;
}

/** The request-log fingerprint of a token: the first 16 hex chars of its SHA-256. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "mcpjam-lazy-auth-fixture", version: "1.0.0" };
const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** `initialize` echoes any of these; anything else gets the newest legacy one. */
const INITIALIZE_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-11-25",
  MODERN_PROTOCOL_VERSION,
];
const LATEST_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
/** 2026-07-28 results of these methods MUST carry `ttlMs` + `cacheScope`. */
const CACHEABLE_MODERN_METHODS = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);
const SERVER_CAPABILITIES = { tools: {}, resources: {}, prompts: {} };
const ALL_AS_SCOPES = [...LAZY_AUTH_RESOURCE_SCOPES, "offline_access"];
const AUTHORIZATION_CODE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// MCP surface
// ---------------------------------------------------------------------------

const PRODUCTS = [
  { id: "prod_1", name: "Espresso machine", price: 249 },
  { id: "prod_2", name: "Coffee grinder", price: 89.5 },
  { id: "prod_3", name: "Milk frother", price: 39 },
];

const ORDERS = [
  { id: "ord_1001", item: "Espresso machine", status: "shipped" },
  { id: "ord_1002", item: "Coffee grinder", status: "processing" },
];

/**
 * What a protected operation needs, and the copy shown when it is refused.
 * `undefined` for public operations (and unknown names, which dispatch rejects).
 */
interface Protection {
  scope: string;
  /** `error_description` of the `http401` challenge; text of a `meta` refusal. */
  signInMessage: string;
}

const PROTECTED_TOOLS: Record<string, Protection> = {
  get_my_orders: {
    scope: ORDERS_READ_SCOPE,
    signInMessage: "Sign in to see your orders",
  },
  cancel_order: {
    scope: ORDERS_WRITE_SCOPE,
    signInMessage: "Sign in to cancel your order",
  },
};
const PROTECTED_RESOURCES: Record<string, Protection> = {
  [PROTECTED_RESOURCE_URI]: PROTECTED_TOOLS.get_my_orders,
};
const PROTECTED_PROMPTS: Record<string, Protection> = {
  [PROTECTED_PROMPT_NAME]: PROTECTED_TOOLS.get_my_orders,
};

/**
 * The tool list. `securitySchemes` is emitted both top-level (where OpenAI's
 * Apps SDK documents it) and mirrored in `_meta.securitySchemes` (the
 * back-compat location for clients whose schema strips unknown fields).
 */
function buildTools(mode: LazyAuthMode): Array<Record<string, unknown>> {
  const withSchemes = (
    tool: Record<string, unknown>,
    schemes: Array<Record<string, unknown>> | undefined
  ) =>
    schemes
      ? {
          ...tool,
          securitySchemes: schemes,
          _meta: { securitySchemes: schemes },
        }
      : tool;

  // In these two modes `get_my_orders` declares nothing and so inherits the
  // server default (advertised in `meta-inherited-default`, absent in
  // `meta-no-default`).
  const ordersToolOmitsSchemes =
    mode === "meta-inherited-default" || mode === "meta-no-default";

  return [
    withSchemes(
      {
        name: "list_products",
        title: "List products",
        description:
          "Lists the products in the public catalog. No sign-in needed.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      [{ type: "noauth" }]
    ),
    withSchemes(
      {
        name: "get_my_orders",
        title: "Get my orders",
        description:
          "Lists the signed-in user's recent orders. Requires sign-in.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      ordersToolOmitsSchemes
        ? undefined
        : [{ type: "oauth2", scopes: [ORDERS_READ_SCOPE] }]
    ),
    withSchemes(
      {
        name: "cancel_order",
        title: "Cancel order",
        description:
          "Cancels one of the signed-in user's orders. Requires the orders:write scope.",
        inputSchema: {
          type: "object",
          properties: {
            order_id: { type: "string", description: "The order to cancel" },
          },
          required: ["order_id"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      [{ type: "oauth2", scopes: [ORDERS_WRITE_SCOPE] }]
    ),
  ];
}

const RESOURCES = [
  {
    uri: PUBLIC_RESOURCE_URI,
    name: "products",
    title: "Product catalog",
    description: "The public product catalog.",
    mimeType: "application/json",
  },
  {
    uri: PROTECTED_RESOURCE_URI,
    name: "recent-orders",
    title: "Recent orders",
    description: "The signed-in user's recent orders. Requires sign-in.",
    mimeType: "application/json",
  },
];

const PROMPTS = [
  {
    name: PUBLIC_PROMPT_NAME,
    title: "Product pitch",
    description: "Pitch a product from the catalog. No sign-in needed.",
    arguments: [
      { name: "product", description: "Product name", required: false },
    ],
  },
  {
    name: PROTECTED_PROMPT_NAME,
    title: "Order summary",
    description: "Summarize the signed-in user's orders. Requires sign-in.",
    arguments: [],
  },
];

/**
 * The server-level default `securitySchemes` of `meta-inherited-default`.
 *
 * WHERE a server advertises this default is a GUESS: OpenAI documents that a
 * tool without `securitySchemes` inherits the server's default, but not where
 * ChatGPT reads that default from. This fixture puts it in the `initialize`
 * result's `_meta.securitySchemes` (and, for the 2026-07-28 era, the
 * `server/discover` result's `_meta.securitySchemes`). Update this when the
 * real location is known.
 */
const SERVER_DEFAULT_SECURITY_SCHEMES = [
  { type: "oauth2", scopes: [ORDERS_READ_SCOPE, ORDERS_WRITE_SCOPE] },
];

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcError {
  code: number;
  message: string;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

/** An HTTP-level refusal: the request never reaches JSON-RPC dispatch. */
interface HttpDenial {
  status: 401 | 403;
  wwwAuthenticate?: string;
  body: Record<string, unknown>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res
    .writeHead(status, { "Content-Type": "application/json", ...headers })
    .end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res
    .writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
    .end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location }).end();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collect a request body as text (for form-encoded and JSON OAuth requests). */
async function readText(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write the CORS headers a browser-hosted client (the inspector UI) needs to
 * read challenges and redirects. Requested headers are reflected because `*`
 * does not cover `Authorization`.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ??
      "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Mcp-Session-Id, Location"
  );
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

interface AccessGrant {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface RefreshGrant {
  clientId: string;
  scopes: string[];
  resource: string;
}

interface RegisteredClient {
  redirectUris: string[];
  clientName?: string;
}

interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
}

interface AuthorizationCode extends PendingAuthorization {
  expiresAt: number;
}

/**
 * Start the fixture on an ephemeral port. Close it with `close()`.
 */
export async function startLazyAuthServer(
  options: LazyAuthServerOptions
): Promise<LazyAuthServer> {
  const { mode } = options;
  const transport: LazyAuthTransport = options.transport ?? "streamable-http";
  const host = options.host ?? "127.0.0.1";
  const accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
  const endpointPath = transport === "sse" ? "/sse" : "/mcp";
  const authEnabled = mode !== "none";

  // Fixed once the port is known (below); handlers only run after that.
  let origin = "";
  let resourceUrl = "";
  let resourceMetadataUrl = "";

  const requests: LazyAuthRequestLog[] = [];
  const accessTokens = new Map<string, AccessGrant>();
  const refreshTokens = new Map<string, RefreshGrant>();
  const clients = new Map<string, RegisteredClient>();
  const pendingAuthorizations = new Map<string, PendingAuthorization>();
  const authorizationCodes = new Map<string, AuthorizationCode>();
  const sseStreams = new Map<string, ServerResponse>();

  const tools = buildTools(mode);

  // ---- tokens -------------------------------------------------------------

  function issueAccessToken(
    grant: Omit<AccessGrant, "expiresAt">,
    ttlSeconds = accessTokenTtlSeconds
  ): string {
    const token = opaqueToken("lat");
    accessTokens.set(token, {
      ...grant,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return token;
  }

  /** A grant for the request's bearer token, or `undefined` if none is valid here. */
  function validGrant(token: string | undefined): AccessGrant | undefined {
    if (!token) return undefined;
    const grant = accessTokens.get(token);
    if (!grant) return undefined;
    if (grant.expiresAt <= Date.now()) return undefined;
    // Audience-restricted (RFC 8707): a token for another resource is invalid.
    if (grant.resource !== resourceUrl) return undefined;
    return grant;
  }

  // ---- the auth gate ------------------------------------------------------

  /** The protection of a JSON-RPC request, if it is a protected operation. */
  function protectionFor(
    rpcMethod: string,
    params: Record<string, unknown>
  ): Protection | undefined {
    if (!authEnabled) return undefined;
    if (rpcMethod === "tools/call") return PROTECTED_TOOLS[String(params.name)];
    if (rpcMethod === "resources/read")
      return PROTECTED_RESOURCES[String(params.uri)];
    if (rpcMethod === "prompts/get")
      return PROTECTED_PROMPTS[String(params.name)];
    return undefined;
  }

  /** The `meta*` challenge string, per mode. */
  function metaChallenge(): string {
    const base = `Bearer resource_metadata="${resourceMetadataUrl}", error="insufficient_scope"`;
    return mode === "meta-no-error-description"
      ? base
      : `${base}, error_description="You need to login to continue"`;
  }

  /**
   * How a protected operation without a valid token is refused: an HTTP
   * denial, a `200` tool result carrying the `_meta` challenge, or (for
   * resources/prompts in the `meta*` modes) a JSON-RPC error.
   */
  function missingTokenDenial(
    rpcMethod: string,
    protection: Protection
  ):
    | { http: HttpDenial }
    | { result: Record<string, unknown> }
    | { error: JsonRpcError } {
    const body = {
      error: "invalid_token",
      error_description: protection.signInMessage,
    };
    switch (mode) {
      case "http401":
      case "http403-noscope":
        return {
          http: {
            status: 401,
            wwwAuthenticate: `Bearer error="invalid_token", error_description="${protection.signInMessage}", resource_metadata="${resourceMetadataUrl}", scope="${protection.scope}"`,
            body,
          },
        };
      case "http401-bare":
        return { http: { status: 401, wwwAuthenticate: "Bearer", body } };
      case "http401-noheader":
        return { http: { status: 401, body } };
      case "http401-no-rm":
        return {
          http: {
            status: 401,
            wwwAuthenticate: `Bearer scope="${protection.scope}"`,
            body,
          },
        };
      case "prm-pointer-only":
        return {
          http: {
            status: 401,
            wwwAuthenticate: `Bearer resource_metadata="${resourceMetadataUrl}"`,
            body,
          },
        };
      case "meta":
      case "meta-string":
      case "meta-inherited-default":
      case "meta-no-default":
      case "meta-no-error-description": {
        if (rpcMethod !== "tools/call") {
          return {
            error: {
              code: AUTH_REQUIRED_RPC_ERROR_CODE,
              message: `Authentication required: ${protection.signInMessage}.`,
            },
          };
        }
        const challenge = metaChallenge();
        return {
          result: {
            content: [{ type: "text", text: `${protection.signInMessage}.` }],
            isError: true,
            _meta: {
              [META_WWW_AUTHENTICATE_KEY]:
                mode === "meta-string" ? challenge : [challenge],
            },
          },
        };
      }
      case "none":
        throw new Error("unreachable: mode `none` protects nothing");
    }
  }

  /** The `403` step-up for a valid token that lacks the needed scope. */
  function insufficientScopeDenial(protection: Protection): HttpDenial {
    return {
      status: 403,
      wwwAuthenticate:
        mode === "http403-noscope"
          ? `Bearer error="insufficient_scope"`
          : `Bearer error="insufficient_scope", scope="${protection.scope}", resource_metadata="${resourceMetadataUrl}"`,
      body: {
        error: "insufficient_scope",
        error_description: `This operation needs the ${protection.scope} scope.`,
      },
    };
  }

  // ---- JSON-RPC dispatch --------------------------------------------------

  /** Results the handlers return, before era-specific encoding. */
  type HandlerOutcome =
    { result: Record<string, unknown> } | { error: JsonRpcError };

  const invalidParams = (message: string): HandlerOutcome => ({
    error: { code: -32602, message },
  });

  function dispatch(
    rpcMethod: string,
    params: Record<string, unknown>
  ): HandlerOutcome {
    switch (rpcMethod) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        return {
          result: {
            protocolVersion: INITIALIZE_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : LATEST_LEGACY_PROTOCOL_VERSION,
            capabilities: SERVER_CAPABILITIES,
            serverInfo: SERVER_INFO,
            instructions:
              "Browse products freely; sign in to see or cancel your orders.",
            ...(mode === "meta-inherited-default"
              ? { _meta: { securitySchemes: SERVER_DEFAULT_SECURITY_SCHEMES } }
              : {}),
          },
        };
      }
      case "server/discover":
        // Legacy HTTP+SSE servers predate the 2026-07-28 era; `-32601` is the
        // definitive legacy signal the client's auto negotiation falls back on.
        if (transport === "sse") break;
        return {
          result: {
            supportedVersions: [MODERN_PROTOCOL_VERSION],
            capabilities: SERVER_CAPABILITIES,
            instructions:
              "Browse products freely; sign in to see or cancel your orders.",
            ...(mode === "meta-inherited-default"
              ? { _meta: { securitySchemes: SERVER_DEFAULT_SECURITY_SCHEMES } }
              : {}),
          },
        };
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools } };
      case "tools/call":
        return callTool(String(params.name), params.arguments);
      case "resources/list":
        return { result: { resources: RESOURCES } };
      case "resources/templates/list":
        return { result: { resourceTemplates: [] } };
      case "resources/read":
        return readResource(String(params.uri));
      case "prompts/list":
        return { result: { prompts: PROMPTS } };
      case "prompts/get":
        return getPrompt(
          String(params.name),
          isRecord(params.arguments) ? params.arguments : {}
        );
    }
    return {
      error: { code: -32601, message: `Method not found: ${rpcMethod}` },
    };
  }

  function callTool(name: string, args: unknown): HandlerOutcome {
    switch (name) {
      case "list_products":
        return {
          result: {
            content: [
              {
                type: "text",
                text: `Products: ${PRODUCTS.map((p) => p.name).join(", ")}`,
              },
            ],
            structuredContent: { products: PRODUCTS },
          },
        };
      case "get_my_orders":
        return {
          result: {
            content: [
              {
                type: "text",
                text: `You have ${ORDERS.length} orders: ${ORDERS.map(
                  (o) => `${o.id} (${o.item}, ${o.status})`
                ).join("; ")}`,
              },
            ],
            structuredContent: { orders: ORDERS },
          },
        };
      case "cancel_order": {
        const orderId = isRecord(args) ? args.order_id : undefined;
        if (typeof orderId !== "string" || orderId.length === 0) {
          return {
            result: {
              content: [{ type: "text", text: "order_id is required" }],
              isError: true,
            },
          };
        }
        return {
          result: {
            content: [{ type: "text", text: `Order ${orderId} cancelled` }],
            structuredContent: { orderId, status: "cancelled" },
          },
        };
      }
    }
    return invalidParams(`Unknown tool: ${name}`);
  }

  function readResource(uri: string): HandlerOutcome {
    if (uri === PUBLIC_RESOURCE_URI) {
      return {
        result: {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(PRODUCTS),
            },
          ],
        },
      };
    }
    if (uri === PROTECTED_RESOURCE_URI) {
      return {
        result: {
          contents: [
            { uri, mimeType: "application/json", text: JSON.stringify(ORDERS) },
          ],
        },
      };
    }
    return invalidParams(`Resource not found: ${uri}`);
  }

  function getPrompt(
    name: string,
    args: Record<string, unknown>
  ): HandlerOutcome {
    if (name === PUBLIC_PROMPT_NAME) {
      const product =
        typeof args.product === "string" ? args.product : PRODUCTS[0].name;
      return {
        result: {
          description: "Pitch a product",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Write a one-line pitch for the ${product}.`,
              },
            },
          ],
        },
      };
    }
    if (name === PROTECTED_PROMPT_NAME) {
      return {
        result: {
          description: "Summarize my orders",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Summarize these orders: ${JSON.stringify(ORDERS)}`,
              },
            },
          ],
        },
      };
    }
    return invalidParams(`Prompt not found: ${name}`);
  }

  /**
   * The 2026-07-28 encode contract (mirrors the official server's): every
   * result carries `resultType: "complete"`, cacheable ones carry
   * `ttlMs`/`cacheScope`, and `_meta` names the server.
   */
  function encodeModernResult(
    rpcMethod: string,
    result: Record<string, unknown>
  ): Record<string, unknown> {
    const meta = isRecord(result._meta) ? result._meta : {};
    return {
      ...result,
      resultType: "complete",
      ...(CACHEABLE_MODERN_METHODS.has(rpcMethod)
        ? { ttlMs: 0, cacheScope: "private" }
        : {}),
      _meta: { ...meta, [SERVER_INFO_META_KEY]: SERVER_INFO },
    };
  }

  /** Whether a request speaks the stateless 2026-07-28 era (per-request `_meta` envelope). */
  function isModernRequest(params: Record<string, unknown>): boolean {
    if (transport === "sse") return false;
    const meta = isRecord(params._meta) ? params._meta : undefined;
    const version = meta?.[PROTOCOL_VERSION_META_KEY];
    return typeof version === "string" && version >= MODERN_PROTOCOL_VERSION;
  }

  /**
   * Run one JSON-RPC message through the gate and dispatch. Shared by both
   * transports: `http` means "answer the HTTP request with this status";
   * otherwise `response` is the JSON-RPC reply (absent for notifications).
   */
  function handleMessage(
    message: unknown,
    token: string | undefined,
    entry: LazyAuthRequestLog
  ): { http?: HttpDenial; response?: JsonRpcResponse } {
    if (!isRecord(message) || typeof message.method !== "string") {
      return {
        response: {
          jsonrpc: "2.0",
          id: requestId(message),
          error: { code: -32600, message: "Invalid Request" },
        },
      };
    }

    const rpcMethod = message.method;
    const params = isRecord(message.params) ? message.params : {};
    entry.rpcMethod = rpcMethod;
    if (rpcMethod === "tools/call") entry.toolName = String(params.name);
    if (rpcMethod === "resources/read") entry.resourceUri = String(params.uri);
    if (rpcMethod === "prompts/get") entry.promptName = String(params.name);

    // A notification (no `id` member) gets no response: `202 Accepted`.
    if (!("id" in message)) return {};
    const id = requestId(message);

    let outcome: HandlerOutcome;
    const protection = protectionFor(rpcMethod, params);
    const grant = protection ? validGrant(token) : undefined;
    if (protection && !grant) {
      const denial = missingTokenDenial(rpcMethod, protection);
      if ("http" in denial) return { http: denial.http };
      outcome = denial;
    } else if (
      protection &&
      grant &&
      !grant.scopes.includes(protection.scope)
    ) {
      return { http: insufficientScopeDenial(protection) };
    } else {
      outcome = dispatch(rpcMethod, params);
    }

    if ("error" in outcome) {
      return { response: { jsonrpc: "2.0", id, error: outcome.error } };
    }
    const result = isModernRequest(params)
      ? encodeModernResult(rpcMethod, outcome.result)
      : outcome.result;
    return { response: { jsonrpc: "2.0", id, result } };
  }

  function sendHttpDenial(res: ServerResponse, denial: HttpDenial): void {
    sendJson(
      res,
      denial.status,
      denial.body,
      denial.wwwAuthenticate
        ? { "WWW-Authenticate": denial.wwwAuthenticate }
        : {}
    );
  }

  // ---- MCP transports -----------------------------------------------------

  async function handleStreamableHttp(
    req: IncomingMessage,
    res: ServerResponse,
    entry: LazyAuthRequestLog
  ): Promise<void> {
    if (req.method !== "POST") {
      // No standalone server→client stream; clients treat 405 as "none offered".
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const message = await readJsonRpcBody(req, res);
    if (!message) return;
    const outcome = handleMessage(message, bearerToken(req), entry);
    if (outcome.http) {
      sendHttpDenial(res, outcome.http);
    } else if (outcome.response) {
      sendJson(res, 200, outcome.response);
    } else {
      res.writeHead(202).end();
    }
  }

  function handleSseOpen(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const sessionId = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    sseStreams.set(sessionId, res);
    req.on("close", () => sseStreams.delete(sessionId));
  }

  async function handleSseMessage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    entry: LazyAuthRequestLog
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const stream = sseStreams.get(url.searchParams.get("sessionId") ?? "");
    if (!stream) {
      sendJson(res, 404, { error: "Unknown or closed SSE session" });
      return;
    }
    const message = await readJsonRpcBody(req, res);
    if (!message) return;
    const outcome = handleMessage(message, bearerToken(req), entry);
    // The gate answers on the POST itself, exactly like Streamable HTTP.
    if (outcome.http) {
      sendHttpDenial(res, outcome.http);
      return;
    }
    res.writeHead(202).end("Accepted");
    if (outcome.response) {
      stream.write(
        `event: message\ndata: ${JSON.stringify(outcome.response)}\n\n`
      );
    }
  }

  // ---- metadata -----------------------------------------------------------

  function protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: resourceUrl,
      authorization_servers: [origin],
      scopes_supported: LAZY_AUTH_RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
    };
  }

  function authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      scopes_supported: ALL_AS_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ---- authorization server ----------------------------------------------

  /** RFC 7591 dynamic registration. Every client is public (`none`). */
  async function handleRegister(
    req: IncomingMessage,
    res: ServerResponse,
    entry: LazyAuthRequestLog
  ): Promise<void> {
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readText(req));
    } catch {
      sendJson(res, 400, {
        error: "invalid_client_metadata",
        error_description: "Body is not JSON",
      });
      return;
    }
    const redirectUris = isRecord(metadata)
      ? metadata.redirect_uris
      : undefined;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string")
    ) {
      sendJson(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of strings",
      });
      return;
    }
    const record = metadata as Record<string, unknown>;
    const clientId = `client_${randomBytes(12).toString("base64url")}`;
    const clientName =
      typeof record.client_name === "string" ? record.client_name : undefined;
    clients.set(clientId, {
      redirectUris: redirectUris as string[],
      clientName,
    });
    entry.oauth = { clientId };
    sendJson(res, 201, {
      ...record,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  /**
   * Resolve a `client_id`: a DCR registration, or (when it is a URL) a Client
   * ID Metadata Document fetched from it. `http:` is allowed only for loopback
   * hosts, so tests can serve their own document.
   */
  async function resolveClient(
    clientId: string
  ): Promise<RegisteredClient | { error: string }> {
    const registered = clients.get(clientId);
    if (registered) return registered;
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return { error: `Unknown client_id: ${clientId}` };
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
    ) {
      return {
        error:
          "A client_id metadata document URL must be https (http only for loopback)",
      };
    }
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          error: `Client metadata document fetch failed: HTTP ${response.status}`,
        };
      }
      const document: unknown = await response.json();
      if (!isRecord(document) || document.client_id !== clientId) {
        return {
          error: "Client metadata document client_id does not match its URL",
        };
      }
      const redirectUris = document.redirect_uris;
      if (
        !Array.isArray(redirectUris) ||
        !redirectUris.every((u) => typeof u === "string")
      ) {
        return { error: "Client metadata document has no redirect_uris" };
      }
      return {
        redirectUris: redirectUris as string[],
        clientName:
          typeof document.client_name === "string"
            ? document.client_name
            : undefined,
      };
    } catch (error) {
      return {
        error: `Client metadata document fetch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** `redirect_uri` with OAuth response parameters appended (always with `iss`). */
  function authorizationResponseUrl(
    redirectUri: string,
    params: Record<string, string | undefined>
  ): string {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    target.searchParams.set("iss", origin);
    return target.toString();
  }

  function authorizeErrorPage(
    res: ServerResponse,
    error: string,
    description: string
  ) {
    sendHtml(
      res,
      400,
      `<!doctype html><html><head><title>Authorization error</title></head><body><h1>${escapeHtml(
        error
      )}</h1><p>${escapeHtml(description)}</p></body></html>`
    );
  }

  async function handleAuthorize(
    res: ServerResponse,
    url: URL,
    entry: LazyAuthRequestLog
  ): Promise<void> {
    const p = url.searchParams;
    const clientId = p.get("client_id") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    entry.oauth = {
      clientId: clientId || undefined,
      responseType: p.get("response_type") ?? undefined,
      redirectUri: redirectUri || undefined,
      scope: p.get("scope") ?? undefined,
      resource: p.get("resource") ?? undefined,
    };

    // Until the client and redirect URI are trusted, errors are shown here,
    // never redirected (RFC 6749 §4.1.2.1).
    if (!clientId) {
      authorizeErrorPage(res, "invalid_request", "client_id is required");
      return;
    }
    const client = await resolveClient(clientId);
    if ("error" in client) {
      authorizeErrorPage(res, "invalid_client", client.error);
      return;
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      authorizeErrorPage(
        res,
        "invalid_request",
        "redirect_uri is missing or not registered for this client"
      );
      return;
    }

    const state = p.get("state") ?? "";
    const fail = (error: string, description: string) =>
      redirect(
        res,
        authorizationResponseUrl(redirectUri, {
          error,
          error_description: description,
          state: state || undefined,
        })
      );

    if (p.get("response_type") !== "code") {
      fail("unsupported_response_type", "response_type must be code");
      return;
    }
    if (!state) {
      fail("invalid_request", "state is required");
      return;
    }
    const codeChallenge = p.get("code_challenge") ?? "";
    if (!codeChallenge || p.get("code_challenge_method") !== "S256") {
      fail(
        "invalid_request",
        "PKCE is required: code_challenge with code_challenge_method=S256"
      );
      return;
    }
    const resource = p.get("resource");
    if (resource !== null && resource !== resourceUrl) {
      fail("invalid_target", `Unknown resource: ${resource}`);
      return;
    }
    const scopeParam = p.get("scope");
    const scopes = scopeParam
      ? scopeParam.split(" ").filter(Boolean)
      : [...LAZY_AUTH_RESOURCE_SCOPES];
    const unknownScope = scopes.find((scope) => !ALL_AS_SCOPES.includes(scope));
    if (unknownScope) {
      fail("invalid_scope", `Unknown scope: ${unknownScope}`);
      return;
    }

    const requestIdValue = randomUUID();
    pendingAuthorizations.set(requestIdValue, {
      clientId,
      clientName: client.clientName,
      redirectUri,
      state,
      codeChallenge,
      scopes,
      resource: resource ?? resourceUrl,
    });

    const who = escapeHtml(client.clientName ?? clientId);
    sendHtml(
      res,
      200,
      `<!doctype html>
<html>
  <head><title>Authorize ${who}</title></head>
  <body>
    <h1>Authorize ${who}</h1>
    <p>${who} wants to access your orders with: ${escapeHtml(scopes.join(" "))}</p>
    <form method="post" action="/authorize/approve">
      <input type="hidden" name="request_id" value="${requestIdValue}">
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </body>
</html>`
    );
  }

  async function handleApprove(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const form = new URLSearchParams(await readText(req));
    const pendingId = form.get("request_id") ?? "";
    const pending = pendingAuthorizations.get(pendingId);
    if (!pending) {
      authorizeErrorPage(
        res,
        "invalid_request",
        "Unknown or already used authorization request"
      );
      return;
    }
    pendingAuthorizations.delete(pendingId);

    if (form.get("decision") === "deny") {
      redirect(
        res,
        authorizationResponseUrl(pending.redirectUri, {
          error: "access_denied",
          error_description: "The user denied the request",
          state: pending.state,
        })
      );
      return;
    }

    const code = opaqueToken("code");
    authorizationCodes.set(code, {
      ...pending,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
    });
    redirect(
      res,
      authorizationResponseUrl(pending.redirectUri, {
        code,
        state: pending.state,
      })
    );
  }

  async function handleToken(
    req: IncomingMessage,
    res: ServerResponse,
    entry: LazyAuthRequestLog
  ): Promise<void> {
    const form = new URLSearchParams(await readText(req));
    // Public clients send `client_id` in the body; accept Basic too, ignoring
    // any secret (every client here is public).
    let clientId = form.get("client_id") ?? "";
    const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1];
    if (!clientId && basic) {
      clientId = decodeURIComponent(
        Buffer.from(basic, "base64").toString("utf8").split(":")[0] ?? ""
      );
    }
    const grantType = form.get("grant_type") ?? "";
    entry.oauth = {
      clientId: clientId || undefined,
      grantType: grantType || undefined,
      redirectUri: form.get("redirect_uri") ?? undefined,
      scope: form.get("scope") ?? undefined,
      resource: form.get("resource") ?? undefined,
    };

    const tokenError = (status: number, error: string, description: string) =>
      sendJson(
        res,
        status,
        { error, error_description: description },
        { "Cache-Control": "no-store" }
      );

    if (!clientId) {
      tokenError(401, "invalid_client", "client_id is required");
      return;
    }

    let grant: RefreshGrant;
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const issued = authorizationCodes.get(code);
      authorizationCodes.delete(code); // one-time use, even on failure
      if (!issued || issued.expiresAt <= Date.now()) {
        tokenError(
          400,
          "invalid_grant",
          "Unknown, used or expired authorization code"
        );
        return;
      }
      if (issued.clientId !== clientId) {
        tokenError(
          400,
          "invalid_grant",
          "The code was issued to another client"
        );
        return;
      }
      if (form.get("redirect_uri") !== issued.redirectUri) {
        tokenError(
          400,
          "invalid_grant",
          "redirect_uri does not match the authorization request"
        );
        return;
      }
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier || base64UrlSha256(verifier) !== issued.codeChallenge) {
        tokenError(400, "invalid_grant", "PKCE verification failed");
        return;
      }
      const resource = form.get("resource");
      if (resource !== null && resource !== issued.resource) {
        tokenError(
          400,
          "invalid_target",
          `resource does not match the authorization: ${resource}`
        );
        return;
      }
      grant = { clientId, scopes: issued.scopes, resource: issued.resource };
    } else if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      const previous = refreshTokens.get(refreshToken);
      if (!previous) {
        tokenError(
          400,
          "invalid_grant",
          "Unknown or already rotated refresh token"
        );
        return;
      }
      if (previous.clientId !== clientId) {
        tokenError(
          400,
          "invalid_grant",
          "The refresh token was issued to another client"
        );
        return;
      }
      const resource = form.get("resource");
      if (resource !== null && resource !== previous.resource) {
        tokenError(
          400,
          "invalid_target",
          `resource does not match the grant: ${resource}`
        );
        return;
      }
      const scopeParam = form.get("scope");
      const scopes = scopeParam
        ? scopeParam.split(" ").filter(Boolean)
        : previous.scopes;
      if (!scopes.every((scope) => previous.scopes.includes(scope))) {
        tokenError(
          400,
          "invalid_scope",
          "A refresh cannot widen the original grant"
        );
        return;
      }
      // Rotation (OAuth 2.1 §4.3.1 for public clients): the old one is spent.
      refreshTokens.delete(refreshToken);
      grant = { clientId, scopes, resource: previous.resource };
    } else {
      tokenError(
        400,
        "unsupported_grant_type",
        `Unsupported grant_type: ${grantType}`
      );
      return;
    }

    const accessToken = issueAccessToken({
      clientId: grant.clientId,
      scopes: grant.scopes,
      resource: grant.resource,
    });
    const refreshToken = opaqueToken("lrt");
    refreshTokens.set(refreshToken, grant);
    sendJson(
      res,
      200,
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: accessTokenTtlSeconds,
        refresh_token: refreshToken,
        scope: grant.scopes.join(" "),
      },
      { "Cache-Control": "no-store" }
    );
  }

  // ---- router -------------------------------------------------------------

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    entry: LazyAuthRequestLog
  ): Promise<void> {
    const path = url.pathname;

    if (path === endpointPath && transport === "streamable-http") {
      await handleStreamableHttp(req, res, entry);
      return;
    }
    if (path === endpointPath && transport === "sse") {
      handleSseOpen(req, res);
      return;
    }
    if (path === "/messages" && transport === "sse") {
      await handleSseMessage(req, res, url, entry);
      return;
    }

    if (req.method === "GET") {
      // RFC 9728 PRM: path-suffixed and root well-known, unless the mode
      // publishes it only at the pointer (or publishes none at all).
      const wellKnownPrm =
        path === `/.well-known/oauth-protected-resource${endpointPath}` ||
        path === "/.well-known/oauth-protected-resource";
      if (
        authEnabled &&
        ((mode === "prm-pointer-only" && path === PRM_POINTER_PATH) ||
          (mode !== "prm-pointer-only" && wellKnownPrm))
      ) {
        sendJson(res, 200, protectedResourceMetadata());
        return;
      }
      if (
        authEnabled &&
        (path === "/.well-known/oauth-authorization-server" ||
          path === "/.well-known/openid-configuration")
      ) {
        sendJson(res, 200, authorizationServerMetadata());
        return;
      }
      if (authEnabled && path === "/authorize") {
        await handleAuthorize(res, url, entry);
        return;
      }
    }

    if (req.method === "POST" && authEnabled) {
      if (path === "/authorize/approve") {
        await handleApprove(req, res);
        return;
      }
      if (path === "/token") {
        await handleToken(req, res, entry);
        return;
      }
      if (path === "/register") {
        await handleRegister(req, res, entry);
        return;
      }
    }

    sendJson(res, 404, { error: "not_found", path });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const token = bearerToken(req);
    const entry: LazyAuthRequestLog = {
      method: req.method ?? "GET",
      path: url.pathname,
      status: 0,
      ...(token ? { tokenHash: hashToken(token) } : {}),
    };
    requests.push(entry);

    // Record the status at the moment it is decided, so a test that awaits
    // the response always sees it in the log.
    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      entry.status = args[0] as number;
      return (writeHead as (...a: unknown[]) => ServerResponse).apply(
        this,
        args
      );
    } as typeof res.writeHead;

    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    route(req, res, url, entry).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "server_error",
          error_description:
            error instanceof Error ? error.message : String(error),
        });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  resourceUrl = `${origin}${endpointPath}`;
  resourceMetadataUrl =
    mode === "prm-pointer-only"
      ? `${origin}${PRM_POINTER_PATH}`
      : `${origin}/.well-known/oauth-protected-resource${endpointPath}`;

  return {
    url: resourceUrl,
    origin,
    mode,
    transport,
    resourceMetadataUrl,
    requests,

    mintAccessToken(scopes, mintOptions) {
      return issueAccessToken(
        {
          clientId: "minted-by-test",
          scopes: [...scopes],
          resource: resourceUrl,
        },
        mintOptions?.expiresInSeconds ?? accessTokenTtlSeconds
      );
    },

    async approveAuthorization(authorizeUrl) {
      const page = await fetch(authorizeUrl, { redirect: "manual" });
      if (page.status === 302) {
        // The authorize request was redirected back with an OAuth error.
        return page.headers.get("location") ?? "";
      }
      const html = await page.text();
      if (page.status !== 200) {
        throw new Error(
          `Authorization request refused (HTTP ${page.status}): ${html}`
        );
      }
      const pendingId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
      if (!pendingId) {
        throw new Error("Consent page carried no request_id");
      }
      const approved = await fetch(
        new URL("/authorize/approve", authorizeUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            request_id: pendingId,
            decision: "allow",
          }).toString(),
          redirect: "manual",
        }
      );
      const location = approved.headers.get("location");
      if (approved.status !== 302 || !location) {
        throw new Error(
          `Consent approval failed (HTTP ${approved.status}): ${await approved.text()}`
        );
      }
      return location;
    },

    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of sseStreams.values()) stream.end();
        sseStreams.clear();
        // `close` only stops new connections; clients leave keep-alive
        // sockets (and SSE streams) open, and the promise would never settle.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
