import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  createOAuthStateMachine,
  getBrowserDebugDynamicRegistrationMetadata,
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
   * Explicit client secret (fresh form value or legacy inline config). Takes
   * precedence over the Convex-backed fetch below.
   */
  clientSecret?: string;
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
 * Resolve the pre-registered client secret for the debugger flow. An explicit
 * secret (fresh form value / legacy inline config) wins; otherwise, when the
 * server has a Convex-backed secret, fetch it lazily and memoize the promise so
 * a single flow (initial exchange + any XAA/fallback retry) fetches once. The
 * secret is only ever held in machine memory — never written to localStorage —
 * preserving the #2758 "no secrets in browser storage" guarantee.
 */
function createDebugClientSecretResolver(
  config: InspectorOAuthStateMachineConfig,
): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;

  return () => {
    const explicit = config.clientSecret?.trim();
    if (explicit) {
      return Promise.resolve(explicit);
    }
    if (!config.hasClientSecret) {
      return Promise.resolve(undefined);
    }
    if (!pending) {
      const resolved = tryResolveProjectServer(config.serverName);
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
  const resolveClientSecret = createDebugClientSecretResolver(config);

  return createOAuthStateMachine({
    ...config,
    hasClientSecret: Boolean(config.clientSecret) || Boolean(config.hasClientSecret),
    redirectUrl: getDebugRedirectUrl(),
    requestExecutor: createDebugRequestExecutor(),
    scheduleAutoAdvance: (fn, delayMs) => {
      window.setTimeout(fn, delayMs);
    },
    loadPreregisteredCredentials: async (input) => ({
      ...loadDebugPreregisteredCredentials(input),
      clientSecret: await resolveClientSecret(),
    }),
    dynamicRegistration: getBrowserDebugDynamicRegistrationMetadata(
      config.protocolVersion,
    ),
    clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  });
}
