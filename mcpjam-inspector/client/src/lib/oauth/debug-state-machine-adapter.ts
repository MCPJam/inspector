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
   * the stored `mcp-client-*` record is a clientId-only fallback.
   */
  preregisteredClientId?: string;
  preregisteredClientSecret?: string;
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

export function createInspectorOAuthStateMachine(
  config: InspectorOAuthStateMachineConfig,
) {
  const { preregisteredClientId, preregisteredClientSecret, ...machineConfig } =
    config;
  return createOAuthStateMachine({
    ...machineConfig,
    redirectUrl: getDebugRedirectUrl(),
    requestExecutor: createDebugRequestExecutor(),
    scheduleAutoAdvance: (fn, delayMs) => {
      window.setTimeout(fn, delayMs);
    },
    // Profile credentials are authoritative when configured: the stored
    // `mcp-client-*` record can hold a stale DCR-registered client id, and it
    // never holds a secret — without the explicit secret the machine resolves
    // the token auth method as "none" and the exchange 401s (#3029). Pairing
    // a profile secret with a stored client id would authenticate as the
    // wrong client, so the stored record is only consulted when the profile
    // has no credentials at all.
    loadPreregisteredCredentials: (input) => {
      if (preregisteredClientId || preregisteredClientSecret) {
        return {
          clientId: preregisteredClientId,
          clientSecret: preregisteredClientSecret || undefined,
        };
      }
      return loadDebugPreregisteredCredentials(input);
    },
    dynamicRegistration: getBrowserDebugDynamicRegistrationMetadata(
      config.protocolVersion,
    ),
    clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  });
}
