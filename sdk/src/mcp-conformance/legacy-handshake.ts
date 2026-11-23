/**
 * The handshake a hand-built 2025-era probe makes before it can address a
 * server: `initialize`, the version check on its answer, and the
 * `notifications/initialized` that ends it.
 *
 * Kept apart from `raw-http.ts`, which only knows how to frame and capture one
 * request. This is the one place that says what a client does between
 * "I sent initialize" and "I may send my probe".
 */

import { needsSetupDetails } from "../conformance-input.js";
import { isKnownProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";
import {
  CONFORMANCE_CLIENT_INFO,
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcError,
  jsonRpcResult,
  legacyHeaders,
  rawRequest,
  type RawHttpResult,
} from "./raw-http.js";
import type { RawHttpCheckContext } from "./types.js";

/**
 * The 2025-era `initialize` prelude a raw legacy probe needs before it can
 * address a stateful server. Returns the exchange verbatim plus the minted
 * session id (absent for a stateless legacy server — that is a legitimate
 * outcome, not an error).
 *
 * `negotiatedVersion` is the version the server answered with, when MCPJam
 * supports it. "The protocol version sent by the client SHOULD be the one
 * negotiated during initialization", so a caller sends it in
 * `MCP-Protocol-Version` on the requests that follow, the closing DELETE
 * included.
 *
 * `versionStop` is set whenever the answered version is not the one the run
 * uses. A server answers with another version only when it does not support
 * the one it was asked for ("If the server supports the requested protocol
 * version, it MUST respond with the same version"). A version MCPJam does not
 * support is one case: "If the client does not support the version in the
 * server's response, it SHOULD disconnect". A version MCPJam does support but
 * the run does not use is the other: a run is about one version, so it stops
 * instead of quietly grading another. Either way a caller that sees it sends
 * nothing more on that session but the closing DELETE.
 *
 * `initialized` is the `notifications/initialized` POST that ends the
 * handshake. "After successful initialization, the client MUST send an
 * `initialized` notification", so it goes out here, once, before the caller
 * sends anything else. It is absent when the handshake did not succeed: the
 * server refused `initialize`, or answered with a version the run stops on.
 * Notification POST Accepted grades this exchange instead of sending its own.
 */
export async function legacyInitialize(ctx: RawHttpCheckContext): Promise<{
  result: RawHttpResult;
  sessionId?: string;
  negotiatedVersion?: string;
  versionStop?: LegacyVersionStop;
  initialized?: LegacyInitializedNotification;
}> {
  const requestedVersion =
    ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION;
  const result = await rawRequest(ctx, {
    headers: legacyHeaders({}),
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: requestedVersion,
        capabilities: {},
        clientInfo: { ...CONFORMANCE_CLIENT_INFO },
      },
    },
  });

  const sessionId = result.headers["mcp-session-id"];
  const answeredVersion = jsonRpcResult(result)?.protocolVersion;
  if (typeof answeredVersion !== "string") {
    return {
      result,
      sessionId,
      ...(await initializedAfter(ctx, result, sessionId, requestedVersion)),
    };
  }
  const supported = isKnownProtocolVersion(answeredVersion);
  if (answeredVersion !== requestedVersion) {
    // The run stops here, so the handshake is not completed.
    return {
      result,
      sessionId,
      ...(supported ? { negotiatedVersion: answeredVersion } : {}),
      versionStop: {
        requestedVersion,
        answeredVersion,
        message: supported
          ? differentVersionStop(requestedVersion, answeredVersion)
          : unsupportedVersionStop(answeredVersion),
      },
    };
  }
  return {
    result,
    sessionId,
    negotiatedVersion: answeredVersion,
    ...(await initializedAfter(ctx, result, sessionId, answeredVersion)),
  };
}

/** The `notifications/initialized` POST that closes a raw legacy handshake. */
export interface LegacyInitializedNotification {
  /** The server's answer, when the POST was delivered. */
  response?: RawHttpResult;
  /** Why the POST could not be delivered, when it was not. */
  error?: string;
  /** How long the POST took. */
  durationMs: number;
}

/**
 * Send `notifications/initialized` when `initialize` succeeded: an HTTP 2xx
 * that is not a JSON-RPC error. A refused `initialize` leaves no handshake to
 * complete, so nothing is sent.
 *
 * A POST that cannot be delivered is recorded, not thrown: the caller's own
 * probe decides what the run can still learn, and only Notification POST
 * Accepted is about this exchange.
 */
async function initializedAfter(
  ctx: RawHttpCheckContext,
  initialize: RawHttpResult,
  sessionId: string | undefined,
  protocolVersion: string
): Promise<{ initialized?: LegacyInitializedNotification }> {
  if (
    initialize.status < 200 ||
    initialize.status >= 300 ||
    jsonRpcError(initialize) !== undefined
  ) {
    return {};
  }
  const startedAt = Date.now();
  try {
    const response = await rawRequest(ctx, {
      headers: legacyHeaders({ protocolVersion, sessionId }),
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    return { initialized: { response, durationMs: Date.now() - startedAt } };
  } catch (error) {
    ctx.config.signal?.throwIfAborted();
    return {
      initialized: {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

/** Why a raw legacy check stopped right after `initialize`. */
export interface LegacyVersionStop {
  /** The version the run uses, sent in `initialize`. */
  requestedVersion: string;
  /** The version the server answered with. */
  answeredVersion: string;
  /** The reason, in plain words, for the check's "could not run". */
  message: string;
}

/**
 * `details` for a check that stopped on a {@link LegacyVersionStop}.
 *
 * When the server answered with a version MCPJam speaks, the run simply asked
 * for one the server does not support, which the spec lets it do. That is the
 * caller's choice of version, not a fault in the server, so the check is
 * marked as a setup gap: it costs no points and the run stays incomplete, like
 * a missing login. A version MCPJam does not speak is not something the caller
 * can pick around, so that stop keeps the plain "could not run".
 */
export function versionStopDetails(
  stop: LegacyVersionStop
): Record<string, unknown> {
  return {
    requestedProtocolVersion: stop.requestedVersion,
    negotiatedProtocolVersion: stop.answeredVersion,
    ...(isKnownProtocolVersion(stop.answeredVersion)
      ? needsSetupDetails("protocolVersion", stop.message)
      : {}),
  };
}

/** The server answered with a version MCPJam speaks, but not the run's. */
function differentVersionStop(requested: string, answered: string): string {
  return `The server does not support protocol version ${requested}, which this run uses: it answered initialize with ${answered}. This check sent nothing more and could not run. Run it on ${answered} instead.`;
}

/** Why a raw legacy check stopped after `initialize`, in plain words. */
export function unsupportedVersionStop(version: string): string {
  return `The server answered initialize with protocol version "${version}", which MCPJam does not support. A client should disconnect in that case, so this check sent nothing more and could not run.`;
}
