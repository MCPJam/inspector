import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  createOAuthStateMachine,
  getBrowserDebugDynamicRegistrationMetadata,
  isLoopbackOAuthUrl,
  type OAuthFlowState,
  type OAuthProtocolVersion,
  type OAuthRequestExecutor,
  type RegistrationStrategy2025_03_26,
  type RegistrationStrategy2025_06_18,
  type RegistrationStrategy2025_11_25,
} from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export interface InspectorOAuthStateMachineConfig {
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  state: OAuthFlowState;
  getState?: () => OAuthFlowState;
  updateState: (updates: Partial<OAuthFlowState>) => void;
  serverUrl: string;
  serverName: string;
  customScopes?: string;
  customHeaders?: Record<string, string>;
  /**
   * Credentials the user configured on the OAuth test profile ("Configure
   * Server to Test" → Client credentials). Secrets are never written to
   * localStorage, so they can only reach the state machine through here —
   * the stored `mcp-client-*` record is a clientId-only fallback. An explicit
   * secret takes precedence over the Convex-backed fetch below.
   */
  preregisteredClientId?: string;
  preregisteredClientSecret?: string;
  /**
   * Whether a client secret is stored in Convex for this server. Since #2758
   * secrets no longer live in browser storage, so the debugger must fetch the
   * secret at token-exchange time (mirroring the connect flow's
   * `MCPOAuthProvider.loadStoredClientSecret`).
   */
  hasClientSecret?: boolean;
}

function normalizeResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function serializeProxyBody(
  body: unknown,
  headers: Record<string, string>,
): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }

  const contentType =
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params =
      typeof body === "string"
        ? new URLSearchParams(body)
        : new URLSearchParams();
    return Object.fromEntries(params.entries());
  }

  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body;
}

export function createDebugRequestExecutor(): OAuthRequestExecutor {
  return async (request) => {
    const debugProxyPath = HOSTED_MODE
      ? "/api/web/oauth/debug/proxy"
      : "/api/mcp/oauth/debug/proxy";

    const proxyResponse = await authFetch(debugProxyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: request.url,
        method: request.method,
        headers: {
          Accept: "application/json, text/event-stream",
          ...request.headers,
        },
        body: serializeProxyBody(request.body, request.headers),
        ...(request.redirect ? { redirect: request.redirect } : {}),
      }),
    });

    if (!proxyResponse.ok) {
      throw new Error(
        `Backend debug proxy error: ${proxyResponse.status} ${proxyResponse.statusText}`,
      );
    }

    const data = await proxyResponse.json();
    return {
      status: data.status,
      statusText: data.statusText,
      headers: normalizeResponseHeaders(data.headers ?? {}),
      body: data.body,
      ok: data.status >= 200 && data.status < 300,
    };
  };
}

export function getDebugRedirectUrl(): string {
  return `${window.location.origin}/oauth/callback/debug`;
}

export function loadDebugPreregisteredCredentials({
  serverName,
}: {
  serverName: string;
  serverUrl: string;
}): {
  clientId?: string;
} {
  try {
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    if (!storedClientInfo) {
      return {};
    }

    const parsed = JSON.parse(storedClientInfo);
    if (parsed && typeof parsed === "object" && "client_secret" in parsed) {
      localStorage.setItem(
        `mcp-client-${serverName}`,
        JSON.stringify({ client_id: parsed.client_id || undefined }),
      );
    }
    return {
      clientId: parsed.client_id || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve the Convex-backed client secret for the debugger flow. When the
 * server has a stored secret, fetch it lazily and memoize the promise so a
 * single flow (initial exchange + any fallback retry) fetches once. The
 * secret is only ever held in machine memory — never written to localStorage —
 * preserving the #2758 "no secrets in browser storage" guarantee. An explicit
 * profile secret short-circuits this resolver at the call site.
 */
function createHostedClientSecretResolver({
  serverName,
  hasClientSecret,
}: Pick<
  InspectorOAuthStateMachineConfig,
  "serverName" | "hasClientSecret"
>): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;

  return () => {
    if (!hasClientSecret) {
      return Promise.resolve(undefined);
    }
    if (!pending) {
      const resolved = tryResolveProjectServer(serverName);
      if (!resolved) {
        return Promise.resolve(undefined);
      }
      pending = fetchOAuthClientSecret({
        projectId: resolved.projectId,
        serverId: resolved.serverId,
      })
        .then((result) => result.clientSecret)
        .catch(() => {
          // Degrade to an unauthenticated token request rather than aborting
          // the flow; the resulting 401 stays visible in the HTTP history.
          // Clear the memo so a later retry can re-attempt the fetch.
          pending = undefined;
          return undefined;
        });
    }
    return pending;
  };
}

export function createInspectorOAuthStateMachine(
  config: InspectorOAuthStateMachineConfig,
) {
  const {
    preregisteredClientId,
    preregisteredClientSecret,
    hasClientSecret,
    ...machineConfig
  } = config;
  const explicitClientSecret = preregisteredClientSecret?.trim() || undefined;
  const resolveHostedClientSecret = createHostedClientSecretResolver(config);

  return createOAuthStateMachine({
    ...machineConfig,
    hasClientSecret: Boolean(explicitClientSecret) || Boolean(hasClientSecret),
    redirectUrl: getDebugRedirectUrl(),
    requestExecutor: createDebugRequestExecutor(),
    // The debugger is a local-dev inspection surface: when the server under
    // test is itself loopback (e.g. a `127.0.0.1` dev MCP server), its metadata
    // fetches must be permitted. Mirror the Connect flow — allow loopback only
    // when the debugged server URL is loopback; the guard still blocks
    // LAN/link-local/reserved destinations regardless.
    allowLoopbackMetadataFetch: isLoopbackOAuthUrl(machineConfig.serverUrl),
    // One step per "Continue" click: `scheduleAutoAdvance` is intentionally not
    // provided. The SDK state machines call it via optional chaining, so when
    // it is absent each `proceedToNextStep()` stops at the next step instead of
    // chaining a prepare → send → receive burst (or the multi-hop CIMD
    // sequence) on a single click. This lets users inspect every request and
    // response individually — the "prepare" stop even shows the pending request
    // before it is sent. To restore bundled stepping, schedule `fn` on a timer
    // here again, e.g. `scheduleAutoAdvance: (fn, delayMs) => window.setTimeout(fn, delayMs)`.
    // Profile credentials are authoritative when configured: the stored
    // `mcp-client-*` record can hold a stale DCR-registered client id, and it
    // never holds a secret — without the explicit secret the machine resolves
    // the token auth method as "none" and the exchange 401s (#3029). Pairing
    // a profile secret with a stored client id would authenticate as the
    // wrong client, so the stored record is only consulted when the profile
    // has no credentials at all. The Convex-backed secret, by contrast, may
    // pair with either id source — it belongs to the synced server record,
    // mirroring the Connect flow's stored-info + fetched-secret merge.
    loadPreregisteredCredentials: async (input) => {
      if (preregisteredClientId || explicitClientSecret) {
        return {
          clientId: preregisteredClientId,
          clientSecret:
            explicitClientSecret ?? (await resolveHostedClientSecret()),
        };
      }
      return {
        ...loadDebugPreregisteredCredentials(input),
        clientSecret: await resolveHostedClientSecret(),
      };
    },
    dynamicRegistration: getBrowserDebugDynamicRegistrationMetadata(
      config.protocolVersion,
    ),
    clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  });
}
