import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { buildResourceMetadataUrl } from "./oauth/state-machines/shared/urls.js";
import type {
  OAuthProtocolVersion,
} from "./oauth/state-machines/types.js";

export interface ProbeMcpServerConfig {
  url: string;
  protocolVersion?: OAuthProtocolVersion;
  headers?: Record<string, string>;
  accessToken?: string;
  clientCapabilities?: Record<string, unknown>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
}

export interface ProbeHttpAttempt {
  name:
    | "streamable_initialize"
    | "sse_probe"
    | "resource_metadata"
    | "authorization_server_metadata";
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: unknown;
    contentType?: string;
  };
  error?: string;
  durationMs: number;
}

export interface ProbeOAuthDetails {
  required: boolean;
  optional: boolean;
  wwwAuthenticate?: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: Record<string, unknown>;
  authorizationServerMetadataUrl?: string;
  authorizationServerMetadata?: Record<string, unknown>;
  registrationStrategies: Array<"preregistered" | "dcr" | "cimd">;
  discoveryError?: string;
}

export interface ProbeInitializeInfo {
  protocolVersion?: string;
  serverInfo?: unknown;
  capabilities?: unknown;
  contentType?: string;
}

export interface ProbeTransportResult {
  selected?: "streamable-http" | "sse";
  attempts: ProbeHttpAttempt[];
}

export interface ProbeMcpServerResult {
  url: string;
  protocolVersion: OAuthProtocolVersion;
  status: "ready" | "oauth_required" | "reachable" | "error";
  transport: ProbeTransportResult;
  initialize?: ProbeInitializeInfo;
  oauth: ProbeOAuthDetails;
  error?: string;
}

type ParsedHttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: unknown;
  contentType?: string;
};

function normalizeProtocolVersion(
  value: OAuthProtocolVersion | undefined,
): OAuthProtocolVersion {
  return value ?? "2025-11-25";
}

function normalizeHeaders(
  headers: Headers | HeadersInit | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function removeAuthorizationHeader(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => key.toLowerCase() !== "authorization",
    ),
  );
}

function initializeProtocolVersion(
  protocolVersion: OAuthProtocolVersion,
): string {
  switch (protocolVersion) {
    case "2025-03-26":
    case "2025-06-18":
      return "2024-11-05";
    case "2025-11-25":
      return "2025-11-25";
    default: {
      const exhaustive: never = protocolVersion;
      return exhaustive;
    }
  }
}

function buildAuthServerMetadataUrls(
  protocolVersion: OAuthProtocolVersion,
  authServerUrl: string,
): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  if (protocolVersion === "2025-11-25") {
    if (url.pathname === "/" || url.pathname === "") {
      urls.push(
        new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
      );
      urls.push(
        new URL("/.well-known/openid-configuration", url.origin).toString(),
      );
      return urls;
    }

    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL(
        `/.well-known/openid-configuration${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL(
        `${pathname}/.well-known/openid-configuration`,
        url.origin,
      ).toString(),
    );
    return urls;
  }

  if (url.pathname === "/" || url.pathname === "") {
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
    );
    return urls;
  }

  const pathname = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  urls.push(
    new URL(
      `/.well-known/oauth-authorization-server${pathname}`,
      url.origin,
    ).toString(),
  );
  urls.push(
    new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
  );
  return urls;
}

function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

async function readResponseBody(
  response: Response,
): Promise<{ body?: unknown; contentType?: string }> {
  const contentType = response.headers.get("content-type") ?? undefined;
  if (contentType?.includes("text/event-stream")) {
    return { contentType };
  }

  const text = await response.text();
  if (!text) {
    return { body: undefined, contentType };
  }

  if (
    contentType?.includes("application/json") ||
    contentType?.includes("+json")
  ) {
    return {
      body: parseJsonBody(text),
      contentType,
    };
  }

  return {
    body: parseJsonBody(text),
    contentType,
  };
}

function withTimeoutSignal(
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!timeoutMs) {
    return {
      signal: undefined,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(handle),
  };
}

async function performRequest(
  fetchFn: typeof fetch,
  attempt: ProbeHttpAttempt,
  timeoutMs: number | undefined,
): Promise<ParsedHttpResponse> {
  const startedAt = Date.now();
  const { signal, cleanup } = withTimeoutSignal(timeoutMs);

  try {
    const response = await fetchFn(attempt.request.url, {
      method: attempt.request.method,
      headers: attempt.request.headers,
      body:
        attempt.request.body === undefined
          ? undefined
          : JSON.stringify(attempt.request.body),
      redirect: "follow",
      signal,
    });

    const parsedBody = await readResponseBody(response);
    const normalizedHeaders = normalizeHeaders(response.headers);
    attempt.durationMs = Date.now() - startedAt;
    attempt.response = {
      status: response.status,
      statusText: response.statusText,
      headers: normalizedHeaders,
      body: parsedBody.body,
      contentType: parsedBody.contentType,
    };

    return {
      status: response.status,
      statusText: response.statusText,
      headers: lowerCaseHeaders(normalizedHeaders),
      body: parsedBody.body,
      contentType: parsedBody.contentType,
    };
  } catch (error) {
    attempt.durationMs = Date.now() - startedAt;
    attempt.error =
      error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    cleanup();
  }
}

function extractInitializeInfo(
  body: unknown,
  contentType: string | undefined,
): ProbeInitializeInfo | undefined {
  if (
    body &&
    typeof body === "object" &&
    "result" in body &&
    (body as { result?: { protocolVersion?: unknown } }).result?.protocolVersion
  ) {
    const result = (body as {
      result: {
        protocolVersion?: string;
        serverInfo?: unknown;
        capabilities?: unknown;
      };
    }).result;

    return {
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
      contentType,
    };
  }

  if (contentType?.includes("text/event-stream")) {
    return {
      contentType,
    };
  }

  return undefined;
}

function buildInitializeRequest(config: ProbeMcpServerConfig): ProbeHttpAttempt {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const accessToken = config.accessToken?.trim();
  const headers: Record<string, string> = {
    ...normalizeHeaders(config.headers),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return {
    name: "streamable_initialize",
    request: {
      method: "POST",
      url: config.url,
      headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: initializeProtocolVersion(protocolVersion),
          capabilities: config.clientCapabilities ?? {},
          clientInfo: {
            name: config.clientName ?? "mcpjam-probe",
            version: config.clientVersion ?? "1.0.0",
          },
        },
      },
    },
    durationMs: 0,
  };
}

function buildSseProbeRequest(config: ProbeMcpServerConfig): ProbeHttpAttempt {
  const accessToken = config.accessToken?.trim();
  const headers: Record<string, string> = {
    ...normalizeHeaders(config.headers),
    Accept: "text/event-stream",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return {
    name: "sse_probe",
    request: {
      method: "GET",
      url: config.url,
      headers,
    },
    durationMs: 0,
  };
}

function resolveRegistrationStrategies(
  protocolVersion: OAuthProtocolVersion,
  authServerMetadata: Record<string, unknown> | undefined,
): Array<"preregistered" | "dcr" | "cimd"> {
  const strategies: Array<"preregistered" | "dcr" | "cimd"> = [
    "preregistered",
  ];

  if (authServerMetadata?.registration_endpoint) {
    strategies.push("dcr");
  }

  if (
    protocolVersion === "2025-11-25" &&
    authServerMetadata?.client_id_metadata_document_supported === true
  ) {
    strategies.push("cimd");
  }

  return strategies;
}

async function discoverOAuthDetails(
  config: ProbeMcpServerConfig,
  attempts: ProbeHttpAttempt[],
  optional: boolean,
  wwwAuthenticateHeader: string | undefined,
): Promise<ProbeOAuthDetails> {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const metadataHeaders = removeAuthorizationHeader(
    normalizeHeaders(config.headers),
  );
  const resourceMetadataUrlFromHeader = wwwAuthenticateHeader?.match(
    /resource_metadata="([^"]+)"/,
  )?.[1];
  const resourceMetadataUrl =
    resourceMetadataUrlFromHeader ?? buildResourceMetadataUrl(config.url);

  const resourceMetadataAttempt: ProbeHttpAttempt = {
    name: "resource_metadata",
    request: {
      method: "GET",
      url: resourceMetadataUrl,
      headers: metadataHeaders,
    },
    durationMs: 0,
  };
  attempts.push(resourceMetadataAttempt);

  try {
    const loggingFetch: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      const mergedHeaders = {
        ...metadataHeaders,
        ...normalizeHeaders(init.headers),
      };
      const attempt = resourceMetadataAttempt.request.url === url
        ? resourceMetadataAttempt
        : {
            name: "resource_metadata" as const,
            request: {
              method: init.method ?? "GET",
              url,
              headers: mergedHeaders,
            },
            durationMs: 0,
          };
      if (attempt !== resourceMetadataAttempt) {
        attempts.push(attempt);
      } else {
        resourceMetadataAttempt.request.headers = mergedHeaders;
        resourceMetadataAttempt.request.method = init.method ?? "GET";
      }

      const response = await performRequest(
        config.fetchFn ?? fetch,
        attempt,
        config.timeoutMs,
      );

      return new Response(
        response.body === undefined ? null : JSON.stringify(response.body),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    };

    const metadata = await discoverOAuthProtectedResourceMetadata(
      config.url,
      resourceMetadataUrlFromHeader
        ? { resourceMetadataUrl: resourceMetadataUrlFromHeader }
        : undefined,
      loggingFetch,
    );

    const authorizationServerUrl =
      metadata.authorization_servers?.[0] ?? config.url;
    const authMetadataUrls = buildAuthServerMetadataUrls(
      protocolVersion,
      authorizationServerUrl,
    );
    let authorizationServerMetadata:
      | Record<string, unknown>
      | undefined;
    let authorizationServerMetadataUrl: string | undefined;
    let lastAuthError: string | undefined;

    for (const authMetadataUrl of authMetadataUrls) {
      const authAttempt: ProbeHttpAttempt = {
        name: "authorization_server_metadata",
        request: {
          method: "GET",
          url: authMetadataUrl,
          headers: metadataHeaders,
        },
        durationMs: 0,
      };
      attempts.push(authAttempt);

      try {
        const response = await performRequest(
          config.fetchFn ?? fetch,
          authAttempt,
          config.timeoutMs,
        );

        if (
          response.status >= 200 &&
          response.status < 300 &&
          response.body &&
          typeof response.body === "object"
        ) {
          authorizationServerMetadata = response.body as Record<string, unknown>;
          authorizationServerMetadataUrl = authMetadataUrl;
          lastAuthError = undefined;
          break;
        }

        lastAuthError = `HTTP ${response.status} ${response.statusText}`;
      } catch (error) {
        lastAuthError =
          error instanceof Error ? error.message : String(error);
      }
    }

    return {
      required: !optional,
      optional,
      wwwAuthenticate: wwwAuthenticateHeader,
      resourceMetadataUrl,
      resourceMetadata: metadata as Record<string, unknown>,
      authorizationServerMetadataUrl,
      authorizationServerMetadata,
      registrationStrategies: resolveRegistrationStrategies(
        protocolVersion,
        authorizationServerMetadata,
      ),
      ...(lastAuthError ? { discoveryError: lastAuthError } : {}),
    };
  } catch (error) {
    if (optional) {
      return {
        required: false,
        optional: false,
        resourceMetadataUrl,
        registrationStrategies: [],
      };
    }

    return {
      required: true,
      optional: false,
      wwwAuthenticate: wwwAuthenticateHeader,
      resourceMetadataUrl,
      registrationStrategies: ["preregistered"],
      discoveryError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

function baseOAuthResult(): ProbeOAuthDetails {
  return {
    required: false,
    optional: false,
    registrationStrategies: [],
  };
}

export async function probeMcpServer(
  config: ProbeMcpServerConfig,
): Promise<ProbeMcpServerResult> {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const attempts: ProbeHttpAttempt[] = [];
  const initializeAttempt = buildInitializeRequest(config);
  attempts.push(initializeAttempt);

  try {
    const initializeResponse = await performRequest(
      config.fetchFn ?? fetch,
      initializeAttempt,
      config.timeoutMs,
    );
    const initializeInfo = extractInitializeInfo(
      initializeResponse.body,
      initializeResponse.contentType,
    );
    const wwwAuthenticate =
      initializeResponse.headers["www-authenticate"];

    if (initializeResponse.status === 401) {
      return {
        url: config.url,
        protocolVersion,
        status: "oauth_required",
        transport: {
          attempts,
        },
        oauth: await discoverOAuthDetails(
          config,
          attempts,
          false,
          wwwAuthenticate,
        ),
      };
    }

    if (initializeResponse.status >= 200 && initializeResponse.status < 300) {
      const oauth = config.accessToken
        ? baseOAuthResult()
        : await discoverOAuthDetails(config, attempts, true, undefined)
            .catch(() => baseOAuthResult());
      if (initializeInfo) {
        return {
          url: config.url,
          protocolVersion,
          status: "ready",
          transport: {
            selected: "streamable-http",
            attempts,
          },
          initialize: initializeInfo,
          oauth,
        };
      }

      return {
        url: config.url,
        protocolVersion,
        status: "reachable",
        transport: {
          attempts,
        },
        oauth,
        error: "Server responded to initialize but did not return a recognizable MCP initialize result.",
      };
    }

    const shouldTrySse =
      initializeResponse.status === 404 ||
      initializeResponse.status === 405 ||
      initializeResponse.status === 406 ||
      initializeResponse.status === 415 ||
      initializeResponse.status === 501;

    if (shouldTrySse) {
      const sseAttempt = buildSseProbeRequest(config);
      attempts.push(sseAttempt);
      const sseResponse = await performRequest(
        config.fetchFn ?? fetch,
        sseAttempt,
        config.timeoutMs,
      );
      const wwwAuthenticateSse = sseResponse.headers["www-authenticate"];

      if (sseResponse.status === 401) {
        return {
          url: config.url,
          protocolVersion,
          status: "oauth_required",
          transport: {
            attempts,
          },
          oauth: await discoverOAuthDetails(
            config,
            attempts,
            false,
            wwwAuthenticateSse,
          ),
        };
      }

      if (
        sseResponse.status >= 200 &&
        sseResponse.status < 300 &&
        sseResponse.contentType?.includes("text/event-stream")
      ) {
        const oauth = config.accessToken
          ? baseOAuthResult()
          : await discoverOAuthDetails(config, attempts, true, undefined)
              .catch(() => baseOAuthResult());
        return {
          url: config.url,
          protocolVersion,
          status: "ready",
          transport: {
            selected: "sse",
            attempts,
          },
          initialize: {
            contentType: sseResponse.contentType,
          },
          oauth,
        };
      }
    }

    return {
      url: config.url,
      protocolVersion,
      status: "reachable",
      transport: {
        attempts,
      },
      oauth: baseOAuthResult(),
      error: `Server responded with HTTP ${initializeResponse.status} ${initializeResponse.statusText} to the initialize probe.`,
    };
  } catch (error) {
    return {
      url: config.url,
      protocolVersion,
      status: "error",
      transport: {
        attempts,
      },
      oauth: baseOAuthResult(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
