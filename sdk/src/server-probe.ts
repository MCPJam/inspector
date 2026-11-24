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

export type { ProbeHttpAttempt } from "./probe-http.js";
export type { ProbeOAuthDetails } from "./oauth/metadata-discovery.js";

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

export interface ProbeMcpServerResult {
  url: string;
  protocolVersion: OAuthProtocolVersion;
  status: "ready" | "oauth_required" | "reachable" | "error";
  transport: ProbeTransportResult;
  initialize?: ProbeInitializeInfo;
  oauth: ProbeOAuthDetails;
  error?: string;
}

function initializeProtocolVersion(
  protocolVersion: OAuthProtocolVersion
): string {
  switch (protocolVersion) {
    case "2025-03-26":
    case "2025-06-18":
      return "2024-11-05";
    case "2025-11-25":
      return "2025-11-25";
    case "2026-07-28":
      return "2026-07-28";
    default: {
      const exhaustive: never = protocolVersion;
      return exhaustive;
    }
  }
}

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

function buildInitializeRequest(
  config: ProbeMcpServerConfig
): ProbeHttpAttempt {
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
  config: ProbeMcpServerConfig,
  attempts: ProbeHttpAttempt[]
): Promise<ProbeMcpServerAttemptResult> {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const initializeAttempt = buildInitializeRequest(config);
  attempts.push(initializeAttempt);

  try {
    // A Streamable HTTP server may answer initialize as an event stream; its
    // first message is the result `extractInitializeInfo` reads.
    const initializeResponse = await performRequest(
      config.fetchFn ?? fetch,
      initializeAttempt,
      config.timeoutMs,
      undefined,
      { firstEventStreamMessage: true }
    );
    const initializeInfo = extractInitializeInfo(
      initializeResponse.body,
      initializeResponse.contentType
    );
    const wwwAuthenticate = initializeResponse.headers["www-authenticate"];

    if (isOAuthChallenge(initializeResponse)) {
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
            initializeResponse.status
          ),
        },
        retryable: false,
      };
    }

    if (initializeResponse.status >= 200 && initializeResponse.status < 300) {
      const oauth = config.accessToken
        ? baseOAuthResult()
        : await discoverAuthorizationMetadata(config, {
            attempts,
            optional: true,
          }).catch(() => baseOAuthResult());
      if (initializeInfo) {
        return {
          result: {
            url: config.url,
            protocolVersion,
            status: "ready",
            transport: {
              selected: "streamable-http",
              attempts,
            },
            initialize: initializeInfo,
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
          oauth,
          error:
            "Server responded to initialize but did not return a recognizable MCP initialize result.",
        },
        retryable: false,
      };
    }

    const shouldTrySse =
      initializeResponse.status === 404 ||
      initializeResponse.status === 405 ||
      initializeResponse.status === 406 ||
      initializeResponse.status === 415 ||
      initializeResponse.status === 501;

    if (!shouldTrySse && isRetryableProbeStatus(initializeResponse.status)) {
      return createProbeErrorResult(
        config,
        protocolVersion,
        attempts,
        `Server responded with HTTP ${initializeResponse.status} ${initializeResponse.statusText} to the initialize probe.`,
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
        error: `Server responded with HTTP ${initializeResponse.status} ${initializeResponse.statusText} to the initialize probe.`,
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
  const outcome = await retryWithPolicy({
    policy: config.retryPolicy,
    operation: () => probeMcpServerOnce(config, attempts),
    shouldRetryResult: (result) => result.retryable,
  });
  // An attempt refused before the dial never reaches `performRequest`'s
  // `finally`, so it would still be carrying live headers here.
  attempts.forEach(redactAttemptCredentials);
  return outcome.result;
}

