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
    Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ??
    "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params =
      typeof body === "string" ? new URLSearchParams(body) : new URLSearchParams();
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
  clientSecret?: string;
} {
  try {
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    if (!storedClientInfo) {
      return {};
    }

    const parsed = JSON.parse(storedClientInfo);
    return {
      clientId: parsed.client_id || undefined,
      clientSecret: parsed.client_secret || undefined,
    };
  } catch {
    return {};
  }
}

export function createInspectorOAuthStateMachine(
  config: InspectorOAuthStateMachineConfig,
) {
  return createOAuthStateMachine({
    ...config,
    redirectUrl: getDebugRedirectUrl(),
    requestExecutor: createDebugRequestExecutor(),
    scheduleAutoAdvance: (fn, delayMs) => {
      window.setTimeout(fn, delayMs);
    },
    loadPreregisteredCredentials: loadDebugPreregisteredCredentials,
    dynamicRegistration: getBrowserDebugDynamicRegistrationMetadata(
      config.protocolVersion,
    ),
    clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  });
}
