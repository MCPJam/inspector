/**
 * The stateless MCP surface behind `/mcp`.
 *
 * `createMcpHandler` builds a fresh `McpServer` per HTTP request from the
 * factory below and serves both protocol generations from it: the modern
 * 2026-07-28 revision, and — via the default `legacy: "stateless"` posture —
 * 2025-era Streamable HTTP clients. There is no Durable Object and no session:
 * nothing about a connection survives the request that created it, so there is
 * no session to hijack and no bearer token at rest.
 *
 * The one piece of cross-request state is the guest-token cache below, which
 * is best-effort by design (see `getBearerToken`).
 */
import {
  createMcpHandler,
  McpServer,
  type McpHandlerRequestOptions,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { createSessionToolRegistrar } from "./tools/sessionToolRegistrar.js";
import { registerPlatformCatalogTools } from "./tools/platformTools.js";
import { registerShowServersTool } from "./tools/showServers.js";
import { DEFAULT_MCPJAM_APP_ORIGIN } from "@mcpjam/sdk/platform";

const SERVER_INFO = {
  name: "MCPJam MCP",
  version: "0.2.0",
} as const;

/**
 * What a model must do with the links these tools return.
 *
 * ONE rule, because it is the one this worker cannot enforce from the
 * outside. Tool results carry a `permalinks` array and a matching text line;
 * a model that instead assembles `app.mcpjam.com/<something>` from an id
 * produces a URL with no project in it, which opens whichever project the
 * READER last selected — a link that looks right, resolves, and shows the
 * wrong data.
 */
const SERVER_INSTRUCTIONS = [
  "Tool results may include a `permalinks` array; the text output repeats each one as a `Label: https://…` line.",
  "Hand those URLs to the user EXACTLY as written. Never invent, shorten, or rewrite an MCPJam app URL, and never build one from an id — a hand-made link opens whichever project the reader last selected, not the one you are describing.",
  "When a result has no permalink, give the id and say which MCPJam screen it lives on.",
].join("\n");

/**
 * Everything a platform tool needs from the request it is executing under.
 * Replaces the `McpJamMcpServer` Durable Object instance the tools used to
 * receive: statelessly there is no long-lived object to hang this off, just a
 * per-request closure.
 */
export interface PlatformToolContext {
  /** The bearer to authenticate Platform API calls with (see `getBearerToken`). */
  getBearerToken(): Promise<string | undefined>;
  runtimeEnv: { PLATFORM_API_URL: string; MCPJAM_APP_ORIGIN: string };
}

// Re-mint a minted guest token this far before its expiry. A guest token is
// long-lived (~24h) but a long-running anonymous client must not start failing
// every tool call the moment it lapses — refresh ahead of the edge.
const GUEST_TOKEN_REFRESH_SLACK_MS = 60_000;

// Cache key for an anonymous request the edge gave us no client IP for. Such
// requests all share one guest identity, which is the same trade the IP-keyed
// entries make for clients behind a shared NAT.
const UNKNOWN_CLIENT_IP = "unknown";

// Bound on the isolate-local cache. Anonymous traffic is low-volume and each
// entry is tiny, but the map must not grow without limit inside a long-lived
// isolate; oldest-first eviction (Map preserves insertion order) just costs the
// evicted client a re-mint.
const GUEST_CACHE_MAX_ENTRIES = 1_000;

type GuestCacheEntry = {
  minted?: { token: string; expiresAt: number };
  inFlight?: Promise<string | undefined>;
};

/**
 * Isolate-global guest-token cache, keyed by client IP. Mirrors `jwksCache` in
 * `auth.ts`: best-effort per isolate (a cold isolate re-mints) and deliberately
 * not backed by KV — the inspector's mint route is the authoritative rate
 * limiter (10/min/IP), and its own comment notes that worker-side limiting is
 * unreliable anyway. Two anonymous users behind one NAT share a guest identity;
 * that is acceptable for throwaway anonymous use.
 */
const guestTokenCache = new Map<string, GuestCacheEntry>();

/**
 * The bearer to authenticate Platform API calls with. For an authenticated
 * request it is the token `index.ts` already verified. For an anonymous one it
 * is a guest token minted lazily on first tool execution (NOT at
 * connect/`tools/list` — listing tools needs no Platform API, so an anonymous
 * preflight must not create a guest session) and re-minted before it expires.
 * Concurrent callers on the same IP share one mint; a mint failure surfaces as
 * a tool error (the caller checks for `undefined`) and is retried next call.
 */
export async function getBearerToken(
  env: Env,
  verifiedToken: string | undefined,
  clientIp: string | undefined
): Promise<string | undefined> {
  if (verifiedToken) return verifiedToken;

  const key = clientIp ?? UNKNOWN_CLIENT_IP;
  let entry = guestTokenCache.get(key);
  if (!entry) {
    entry = {};
    if (guestTokenCache.size >= GUEST_CACHE_MAX_ENTRIES) {
      const oldest = guestTokenCache.keys().next();
      if (!oldest.done) guestTokenCache.delete(oldest.value);
    }
    guestTokenCache.set(key, entry);
  }

  const cached = entry.minted;
  if (cached && cached.expiresAt - Date.now() > GUEST_TOKEN_REFRESH_SLACK_MS) {
    return cached.token;
  }

  // Absent or within the refresh window → (re)mint once, shared across
  // concurrent callers.
  const pending = entry;
  if (!pending.inFlight) {
    pending.inFlight = mintGuestToken(env, clientIp)
      .then((minted) => {
        pending.minted = minted;
        return minted?.token;
      })
      .catch(() => undefined)
      .finally(() => {
        pending.inFlight = undefined; // allow refresh/retry next call
      });
  }
  return pending.inFlight;
}

/**
 * Build the per-request MCP server. `createMcpHandler` calls this once per HTTP
 * request (for either era), so it must register the same surface every time —
 * keep it side-effect-free apart from the registrations themselves.
 */
function buildServer(env: Env, ctx: McpRequestContext): McpServer {
  // `authInfo` is strict pass-through from `index.ts`, which has already
  // verified the bearer (AuthKit or guest). Absent → anonymous request.
  const verifiedToken = ctx.authInfo?.token;
  // Edge-provided client IP, trustworthy here because Cloudflare sets it on the
  // inbound hit. Forwarded to the rate-limited mint route so it can limit per
  // client rather than per worker. `requestInfo` is optional on the context
  // type (stdio serving never sets it), hence the optional chain.
  const clientIp =
    ctx.requestInfo?.headers.get("cf-connecting-ip") ?? undefined;

  const server = new McpServer(SERVER_INFO, {
    // The MCP equivalent of the hosted agent's prompt rule: this worker has no
    // system prompt of its own, so `instructions` is the only place it can
    // tell a model what to do with the URLs it hands back.
    instructions: SERVER_INSTRUCTIONS,
    // The workerd default already resolves to this eval-free validator; passing
    // it explicitly pins that choice regardless of how the bundle is built.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });

  const toolContext: PlatformToolContext = {
    getBearerToken: () => getBearerToken(env, verifiedToken, clientIp),
    runtimeEnv: {
      PLATFORM_API_URL: requirePlatformApiUrl(env),
      MCPJAM_APP_ORIGIN: resolveAppOrigin(env),
    },
  };

  const registrar = createSessionToolRegistrar(server);
  registerShowServersTool(registrar, toolContext);
  registerPlatformCatalogTools(registrar, toolContext);

  return server;
}

/**
 * Serve one `/mcp` request. `authInfo` is pass-through — the handler verifies
 * nothing itself.
 *
 * The handler is built per request so the factory closes over *this* request's
 * `env`. A module-scoped handler reading a shared `let currentEnv` would be
 * unsound: `fetch` awaits request classification (body read + era routing)
 * before it calls the factory, so a second request can reassign the binding in
 * between and the first would build its server against the wrong bindings.
 * The cost is near zero — `createMcpHandler` only allocates the handler object
 * and its event bus; the expensive part, registering the tool catalog, is
 * per-request under this SDK either way, since the factory is invoked once per
 * request by design.
 *
 * `handler.close()` is never called. That is safe only under the no-SSE
 * invariant: this worker registers no subscriptions and its tools emit no
 * progress/logging notifications, so `responseMode: "auto"` never upgrades a
 * response to a stream and no keepalive interval is ever created. Adding
 * either would require closing the handler once the exchange completes.
 */
export function handleMcpRequest(
  request: Request,
  env: Env,
  options?: McpHandlerRequestOptions
): Promise<Response> {
  const handler = createMcpHandler(
    (ctx) => buildServer(env, ctx),
    // The default posture, spelled out: one handler serves the modern era and,
    // through the stateless fallback, 2025-era clients. Legacy clients get no
    // `Mcp-Session-Id` and a spec-compliant 405 on GET/DELETE.
    { legacy: "stateless" }
  );
  return handler.fetch(request, options);
}

/**
 * Every tool on this worker is a Platform API adapter, so a missing
 * `PLATFORM_API_URL` is a deploy-time misconfiguration, not a degraded mode.
 * Without this the optional binding would reach `PlatformApiClient` as
 * `undefined` and every call would fetch `undefined/projects` — an opaque
 * network error instead of a legible one. Mirrors the `AUTHKIT_DOMAIN` /
 * `WORKOS_CLIENT_ID` fail-fast checks in `index.ts`.
 */
function requirePlatformApiUrl(env: Env): string {
  const url = env.PLATFORM_API_URL;
  if (!url) {
    throw new Error("Server misconfigured: PLATFORM_API_URL is not set");
  }
  return url;
}

/**
 * Where a HUMAN opens the links this worker hands back.
 *
 * Explicit `MCPJAM_APP_ORIGIN` first. Falling back to the API URL's origin is
 * not a guess: every configured environment serves the app and `/api/v1` from
 * the same host, so a staging worker keeps minting staging links and a local
 * one keeps minting localhost links without a config change. The hosted
 * default is the last resort, and only reachable if `PLATFORM_API_URL` is
 * itself unparseable — which `requirePlatformApiUrl` has already made
 * unlikely.
 *
 * Never derived inside the SDK: `@mcpjam/sdk/platform` is runtime-agnostic and
 * reads no ambient configuration, so every adapter answers this question for
 * itself.
 */
function resolveAppOrigin(env: Env): string {
  const explicit = env.MCPJAM_APP_ORIGIN?.trim();
  if (explicit) return explicit;
  try {
    return new URL(requirePlatformApiUrl(env)).origin;
  } catch {
    return DEFAULT_MCPJAM_APP_ORIGIN;
  }
}

/**
 * Mint a fresh guest token via the inspector's service-token-gated route
 * (`MCPJAM_GUEST_MINT_URL`). The route mints through the same Convex authority
 * that publishes the guest JWKS the worker verifies against, so the token is
 * accepted on the way back in. The client IP is forwarded in a custom header
 * (cf-connecting-ip would be overwritten by Cloudflare on the worker→inspector
 * hop) so the route can rate-limit per client. Returns the token and its
 * expiry (ms epoch) so the cache can refresh before it lapses; returns
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
