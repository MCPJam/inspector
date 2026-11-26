import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  ProtocolErrorCode,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  specTypeSchemas,
} from "@modelcontextprotocol/client";
import {
  type RetryPolicy,
  isRetryableTransientError,
  retryWithPolicy,
} from "./retry.js";
import { hasBearerChallenge } from "./oauth/state-machines/shared/challenges.js";
import {
  discoverAuthorizationMetadata,
  type ProbeOAuthDetails,
} from "./oauth/metadata-discovery.js";
import {
  normalizeHeaders,
  normalizeProtocolVersion,
  performRequest,
  redactAttemptCredentials,
  type ParsedHttpResponse,
  type ProbeHttpAttempt,
} from "./probe-http.js";
import type { OAuthProtocolVersion } from "./oauth/state-machines/types.js";
import { isStatelessProtocolVersion } from "./mcp-client-manager/mcp-protocol-version.js";

export type { ProbeHttpAttempt } from "./probe-http.js";
export type { ProbeOAuthDetails } from "./oauth/metadata-discovery.js";

export interface ProbeMcpServerConfig {
  url: string;
  /** Auto tries server/discover first. Omit to use the legacy 2025-11-25 probe. */
  protocolVersion?: OAuthProtocolVersion | "auto";
  headers?: Record<string, string>;
  accessToken?: string;
  clientCapabilities?: Record<string, unknown>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
  retryPolicy?: RetryPolicy;
  /**
   * Permit private destinations (loopback, RFC 1918, CGNAT, unique-local) for
   * the metadata pointers this probe follows. The LOCAL inspector and CLI set
   * it; hosted callers leave it unset. Link-local and cloud-metadata
   * destinations stay refused either way.
   */
  allowPrivateNetwork?: boolean;
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

export interface ProbeDiscoverInfo {
  supportedVersions: string[];
  serverInfo?: unknown;
  capabilities: unknown;
  contentType?: string;
}

export interface ProbeMcpServerResult {
  url: string;
  protocolVersion: OAuthProtocolVersion;
  status: "ready" | "oauth_required" | "reachable" | "error";
  transport: ProbeTransportResult;
  initialize?: ProbeInitializeInfo;
  discover?: ProbeDiscoverInfo;
  oauth: ProbeOAuthDetails;
  error?: string;
}

const STATELESS_PROBE_VERSION = "2026-07-28";
// The upstream ProtocolErrorCode enum does not include HeaderMismatch.
const HEADER_MISMATCH = -32020;

type ResolvedProbeConfig = Omit<ProbeMcpServerConfig, "protocolVersion"> & {
  protocolVersion: OAuthProtocolVersion;
};

/**
 * MCP requires 401 + `WWW-Authenticate` to signal that OAuth is needed, but a
 * server fronted by a CDN or WAF — and one treating anonymous access as a scope
 * failure (RFC 6750 §3.1 pairs 403 with `insufficient_scope`) — answers 403
 * instead. A 403 that still carries a Bearer challenge names everything
 * discovery needs, so the probe reads it as "OAuth required" rather than
 * reporting the server as broken. A bare 403 carries nothing to discover from
 * and stays an error.
 */
function isOAuthChallenge(response: ParsedHttpResponse): boolean {
  return (
    response.status === 401 ||
    (response.status === 403 &&
      hasBearerChallenge(response.headers["www-authenticate"]))
  );
}

/** Record a challenge status MCP does not allow, so acceptance is never silent. */
function withChallengeStatus(
  oauth: ProbeOAuthDetails,
  status: number
): ProbeOAuthDetails {
  return status === 401
    ? oauth
    : { ...oauth, nonCompliantChallengeStatus: status };
}

function isRetryableProbeStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status !== 501)
  );
}

function extractInitializeInfo(
  body: unknown,
  contentType: string | undefined
): ProbeInitializeInfo | undefined {
  if (
    body &&
    typeof body === "object" &&
    "result" in body &&
    (body as { result?: { protocolVersion?: unknown } }).result?.protocolVersion
  ) {
    const result = (
      body as {
        result: {
          protocolVersion?: string;
          serverInfo?: unknown;
          capabilities?: unknown;
        };
      }
    ).result;

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

function buildStreamableProbeRequest(
  config: ResolvedProbeConfig,
  method: "server/discover" | "initialize"
): ProbeHttpAttempt {
  const accessToken = config.accessToken?.trim();
  const { protocolVersion } = config;
  const clientInfo = {
    name: config.clientName ?? "mcpjam-probe",
    version: config.clientVersion ?? "1.0.0",
  };
  const capabilities = config.clientCapabilities ?? {};
  const headers: Record<string, string> = {
    ...normalizeHeaders(config.headers),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const modern = method === "server/discover";
  if (modern) {
    headers["mcp-protocol-version"] = protocolVersion;
    headers["mcp-method"] = method;
  }
  const params = modern
    ? {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          [CLIENT_CAPABILITIES_META_KEY]: capabilities,
          [CLIENT_INFO_META_KEY]: clientInfo,
        },
      }
    : {
        protocolVersion:
          protocolVersion === "2025-11-25" ? protocolVersion : "2024-11-05",
        capabilities,
        clientInfo,
      };

  return {
    name: modern ? "stateless_server_discover" : "streamable_initialize",
    request: {
      method: "POST",
      url: config.url,
      headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      },
    },
    durationMs: 0,
  };
}

function extractDiscoverInfo(
  response: ParsedHttpResponse
): ProbeDiscoverInfo | undefined {
  const { body, contentType } = response;
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !isJSONRPCResultResponse(body) ||
    body.id !== 1
  ) {
    return undefined;
  }

  const parsed = specTypeSchemas.DiscoverResult["~standard"].validate(
    body.result
  );
  if (parsed.issues !== undefined) return undefined;
  return {
    supportedVersions: parsed.value.supportedVersions,
    serverInfo: parsed.value._meta?.[SERVER_INFO_META_KEY],
    capabilities: parsed.value.capabilities,
    contentType,
  };
}

function shouldTryLegacyProbe(
  response: ParsedHttpResponse,
  discover: ProbeDiscoverInfo | undefined
): boolean {
  // Treat access denial and transient failures as such, without downgrading.
  if (response.status === 403 || isRetryableProbeStatus(response.status)) {
    return false;
  }

  const error = isJSONRPCErrorResponse(response.body)
    ? response.body.error
    : undefined;
  const versionRefused = error?.code === ProtocolErrorCode.UnsupportedProtocolVersion;
  const data = error?.data;
  const supported = discover?.supportedVersions ??
    (versionRefused && data && typeof data === "object" && "supported" in data
      ? data.supported
      : undefined);
  if (Array.isArray(supported)) {
    return (
      !supported.includes(STATELESS_PROBE_VERSION) &&
      supported.some(
        (version) => typeof version === "string" && !isStatelessProtocolVersion(version)
      )
    );
  }
  return (
    !versionRefused &&
    error?.code !== ProtocolErrorCode.MissingRequiredClientCapability &&
    error?.code !== HEADER_MISMATCH
  );
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

function baseOAuthResult(): ProbeOAuthDetails {
  return {
    required: false,
    optional: false,
    registrationStrategies: [],
  };
}

type ProbeMcpServerAttemptResult = {
  result: ProbeMcpServerResult;
  retryable: boolean;
};

function createProbeErrorResult(
  config: ProbeMcpServerConfig,
  protocolVersion: OAuthProtocolVersion,
  attempts: ProbeHttpAttempt[],
  error: string,
  retryable: boolean
): ProbeMcpServerAttemptResult {
  return {
    result: {
      url: config.url,
      protocolVersion,
      status: "error",
      transport: {
        attempts,
      },
      oauth: baseOAuthResult(),
      error,
    },
    retryable,
  };
}

async function probeMcpServerOnce(
  config: ResolvedProbeConfig,
  attempts: ProbeHttpAttempt[],
  auto = false
): Promise<ProbeMcpServerAttemptResult> {
  const { protocolVersion } = config;
  const modern = protocolVersion === STATELESS_PROBE_VERSION;
  const method = modern ? "server/discover" : "initialize";
  const attempt = buildStreamableProbeRequest(config, method);
  attempts.push(attempt);

  try {
    // Streamable HTTP can send the result in an event stream.
    const response = await performRequest(
      config.fetchFn ?? fetch,
      attempt,
      config.timeoutMs,
      undefined,
      { firstEventStreamMessage: true }
    );
    const wwwAuthenticate = response.headers["www-authenticate"];

    if (isOAuthChallenge(response)) {
      return {
        result: {
          url: config.url,
          protocolVersion,
          status: "oauth_required",
          transport: {
            attempts,
          },
          oauth: withChallengeStatus(
            await discoverAuthorizationMetadata(config, {
              attempts,
              optional: false,
              wwwAuthenticate,
            }),
            response.status
          ),
        },
        retryable: false,
      };
    }

    const discover = modern ? extractDiscoverInfo(response) : undefined;
    if (modern && auto && shouldTryLegacyProbe(response, discover)) {
      return probeMcpServerOnce(
        { ...config, protocolVersion: normalizeProtocolVersion(undefined) },
        attempts
      );
    }

    if (response.status >= 200 && response.status < 300) {
      const oauth = config.accessToken
        ? baseOAuthResult()
        : await discoverAuthorizationMetadata(config, {
            attempts,
            optional: true,
          }).catch(() => baseOAuthResult());
      const initialize = modern
        ? undefined
        : extractInitializeInfo(response.body, response.contentType);
      if (initialize || discover?.supportedVersions.includes(protocolVersion)) {
        return {
          result: {
            url: config.url,
            protocolVersion,
            status: "ready",
            transport: {
              selected: "streamable-http",
              attempts,
            },
            ...(initialize ? { initialize } : { discover }),
            oauth,
          },
          retryable: false,
        };
      }

      return {
        result: {
          url: config.url,
          protocolVersion,
          status: "reachable",
          transport: {
            attempts,
          },
          ...(discover && { discover }),
          oauth,
          error: discover
            ? `Server did not advertise support for ${protocolVersion} in server/discover.`
            : `Server responded to ${method} but did not return a recognizable MCP ${method} result.`,
        },
        retryable: false,
      };
    }

    const shouldTrySse =
      !modern && [404, 405, 406, 415, 501].includes(response.status);

    if (!shouldTrySse && isRetryableProbeStatus(response.status)) {
      return createProbeErrorResult(
        config,
        protocolVersion,
        attempts,
        `Server responded with HTTP ${response.status} ${response.statusText} to the ${method} probe.`,
        true
      );
    }

    if (shouldTrySse) {
      const sseAttempt = buildSseProbeRequest(config);
      attempts.push(sseAttempt);
      const sseResponse = await performRequest(
        config.fetchFn ?? fetch,
        sseAttempt,
        config.timeoutMs
      );
      const wwwAuthenticateSse = sseResponse.headers["www-authenticate"];

      if (isOAuthChallenge(sseResponse)) {
        return {
          result: {
            url: config.url,
            protocolVersion,
            status: "oauth_required",
            transport: {
              attempts,
            },
            oauth: withChallengeStatus(
              await discoverAuthorizationMetadata(config, {
                attempts,
                optional: false,
                wwwAuthenticate: wwwAuthenticateSse,
              }),
              sseResponse.status
            ),
          },
          retryable: false,
        };
      }

      if (
        sseResponse.status >= 200 &&
        sseResponse.status < 300 &&
        sseResponse.contentType?.includes("text/event-stream")
      ) {
        const oauth = config.accessToken
          ? baseOAuthResult()
          : await discoverAuthorizationMetadata(config, {
              attempts,
              optional: true,
            }).catch(() => baseOAuthResult());
        return {
          result: {
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
          },
          retryable: false,
        };
      }

      if (isRetryableProbeStatus(sseResponse.status)) {
        return createProbeErrorResult(
          config,
          protocolVersion,
          attempts,
          `Server responded with HTTP ${sseResponse.status} ${sseResponse.statusText} to the SSE probe.`,
          true
        );
      }
    }

    return {
      result: {
        url: config.url,
        protocolVersion,
        status: "reachable",
        transport: {
          attempts,
        },
        oauth: baseOAuthResult(),
        error: `Server responded with HTTP ${response.status} ${response.statusText} to the ${method} probe.`,
      },
      retryable: false,
    };
  } catch (error) {
    return createProbeErrorResult(
      config,
      protocolVersion,
      attempts,
      error instanceof Error ? error.message : String(error),
      isRetryableTransientError(error)
    );
  }
}

export async function probeMcpServer(
  config: ProbeMcpServerConfig
): Promise<ProbeMcpServerResult> {
  const attempts: ProbeHttpAttempt[] = [];
  const auto = config.protocolVersion === "auto";
  const protocolVersion =
    config.protocolVersion === "auto"
      ? STATELESS_PROBE_VERSION
      : normalizeProtocolVersion(config.protocolVersion);
  const outcome = await retryWithPolicy({
    policy: config.retryPolicy,
    operation: () =>
      probeMcpServerOnce({ ...config, protocolVersion }, attempts, auto),
    shouldRetryResult: (result) => result.retryable,
  });
  // An attempt refused before the dial never reaches `performRequest`'s
  // `finally`, so it would still be carrying live headers here.
  attempts.forEach(redactAttemptCredentials);
  return outcome.result;
}

