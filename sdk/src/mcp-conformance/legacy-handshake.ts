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
import { MCP_ERROR_CODES } from "../mcp-client-manager/mcp-error-codes.js";
import { isKnownProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";
import {
  CONFORMANCE_CLIENT_INFO,
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcError,
  jsonRpcResult,
  legacyHeaders,
  rawRequest,
  resumePolledStream,
  type RawHttpResult,
} from "./raw-http.js";
import type { RawHttpCheckContext } from "./types.js";
import { describePinRefusal } from "./version-refusal.js";

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
 * sends anything else. Notification POST Accepted grades this exchange instead
 * of sending its own.
 *
 * `stop` is the one verdict on the whole handshake. It is absent when the
 * session is ready for a probe, and then `initialized` holds the server's
 * answer. When it is set, the caller sends nothing more on the session but the
 * closing DELETE, and reports `stop.message` as its "could not run".
 */
export async function legacyInitialize(
  ctx: RawHttpCheckContext,
  options: LegacyInitializeOptions = {}
): Promise<LegacyHandshake> {
  const requestedVersion =
    ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION;
  const posted = await rawRequest(ctx, {
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
  // The answer may have been handed to polling; without it the version below
  // cannot be read. No version header yet: nothing is negotiated until then.
  const result = await resumePolledStream(ctx, posted, {
    sessionId: posted.headers["mcp-session-id"],
  });

  // The session comes on the response that carries the InitializeResult,
  // which for a polled answer is the call-back.
  const sessionId =
    result.headers["mcp-session-id"] ?? result.resumed?.sessionId;
  const answeredVersion = jsonRpcResult(result)?.protocolVersion;
  if (typeof answeredVersion === "string" && answeredVersion !== requestedVersion) {
    // The run stops here, so the handshake is not completed.
    const supported = isKnownProtocolVersion(answeredVersion);
    const versionStop: LegacyVersionStop = {
      requestedVersion,
      answeredVersion,
      message: supported
        ? differentVersionStop(requestedVersion, answeredVersion)
        : unsupportedVersionStop(answeredVersion),
    };
    return {
      result,
      sessionId,
      ...(supported ? { negotiatedVersion: answeredVersion } : {}),
      versionStop,
      stop: {
        kind: "version",
        message: versionStop.message,
        details: versionStopDetails(versionStop),
      },
    };
  }
  const answer = {
    result,
    sessionId,
    ...(typeof answeredVersion === "string"
      ? { negotiatedVersion: answeredVersion }
      : {}),
  };

  const refused = initializeRefusal(result, requestedVersion);
  if (refused !== undefined) return { ...answer, stop: refused };

  const startedAt = Date.now();
  try {
    const response = await rawRequest(ctx, {
      headers: legacyHeaders({ protocolVersion: requestedVersion, sessionId }),
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      // Every hand-built session sends this, and a run opens several. Only the
      // copy Notification POST Accepted grades enters the run-wide record, so
      // one server defect is not listed once per session.
      record: options.recordInitialized === true,
    });
    return {
      ...answer,
      initialized: { response, durationMs: Date.now() - startedAt },
    };
  } catch (error) {
    ctx.config.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...answer,
      initialized: { error: reason, durationMs: Date.now() - startedAt },
      stop: {
        kind: "undelivered",
        message: `The initialized notification that ends the handshake could not be delivered (${reason}). This check sent nothing more and could not run.`,
        details: { initializedError: reason },
      },
    };
  }
}

export interface LegacyInitializeOptions {
  /**
   * Put the `notifications/initialized` exchange in the run-wide wire record.
   * Off by default: see the call above.
   */
  recordInitialized?: boolean;
}

/** What every handshake has, whether or not it ended in a usable session. */
interface LegacyHandshakeAnswer {
  /** The `initialize` exchange, verbatim. */
  result: RawHttpResult;
  sessionId?: string;
  negotiatedVersion?: string;
  versionStop?: LegacyVersionStop;
}

/**
 * A finished handshake. Either the session is ready and `initialized` is the
 * server's answer to the notification, or `stop` says why it is not.
 */
export type LegacyHandshake = LegacyHandshakeAnswer &
  (
    | {
        stop?: undefined;
        initialized: { response: RawHttpResult; durationMs: number };
      }
    | {
        stop: LegacyHandshakeStop;
        /** Set when the notification was sent and could not be delivered. */
        initialized?: { error: string; durationMs: number };
      }
  );

/** Why a hand-built legacy session is not ready for a probe. */
export interface LegacyHandshakeStop {
  /**
   * `refused`: the server answered `initialize` with an error.
   * `pin-refused`: that error says it does not speak the run's version.
   * `version`: it answered with a version the run does not use.
   * `undelivered`: the `initialized` notification did not reach it.
   */
  kind: "refused" | "pin-refused" | "version" | "undelivered";
  /** The reason, in plain words, for a check's "could not run". */
  message: string;
  /** `details` for that verdict. */
  details: Record<string, unknown>;
}

/**
 * The stop for an `initialize` the server refused: a status outside 2xx, or a
 * JSON-RPC error on any status. "After successful initialization" there is a
 * notification to send and a session to use; after this there is neither.
 *
 * An answer that is 2xx with no error but no readable result is NOT a refusal:
 * the server did not say no, and the checks that follow are how a broken
 * stream or body gets graded.
 */
function initializeRefusal(
  initialize: RawHttpResult,
  requestedVersion: string
): LegacyHandshakeStop | undefined {
  const rpcError = jsonRpcError(initialize);
  const httpOk = initialize.status >= 200 && initialize.status < 300;
  if (httpOk && rpcError === undefined) return undefined;
  const offered = offeredOnVersionRefusal(rpcError);
  if (rpcError !== undefined && offered !== undefined) {
    // The server may refuse a version it does not speak, and the run chose
    // the version. So this is the caller's setup to change, as it is when the
    // client connection is refused for the pin: no points lost, run incomplete.
    const { message, setupGap } = describePinRefusal(requestedVersion, offered);
    return {
      kind: "pin-refused",
      message,
      details: {
        status: initialize.status,
        error: { code: rpcError.code, message: rpcError.message },
        requestedProtocolVersion: requestedVersion,
        offeredProtocolVersions: offered,
        ...(setupGap ? needsSetupDetails("protocolVersion", message) : {}),
      },
    };
  }
  const how =
    rpcError !== undefined
      ? `a JSON-RPC error (${rpcError.code}: ${rpcError.message})`
      : `HTTP ${initialize.status}`;
  return {
    kind: "refused",
    message: `The server answered initialize with ${how}, so the handshake did not complete. This check sent nothing more and could not run.`,
    // `status` is the key the other raw probes use, and the one the runner
    // reads to turn a 401 into "connect first" instead of this message.
    details: {
      status: initialize.status,
      ...(rpcError !== undefined
        ? { error: { code: rpcError.code, message: rpcError.message } }
        : {}),
    },
  };
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

/**
 * The versions a refused `initialize` says the server supports, when the error
 * is about the version: the 2026 code for it, or the `supported` + `requested`
 * data the 2025 lifecycle page shows on its `-32602` example. An empty list
 * means the server refused the version and named no other. Undefined means the
 * error is about something else.
 */
function offeredOnVersionRefusal(
  error: { code: number; data?: unknown } | undefined
): string[] | undefined {
  if (error === undefined) return undefined;
  const data =
    error.data !== null && typeof error.data === "object"
      ? (error.data as { supported?: unknown; requested?: unknown })
      : {};
  const listed = Array.isArray(data.supported) ? data.supported : undefined;
  // The 2025 shape only on its own code: an internal error (`-32603`) that
  // happens to carry these fields is still the server's failure to grade.
  const aboutVersion =
    error.code === MCP_ERROR_CODES.UnsupportedProtocolVersion ||
    (error.code === MCP_ERROR_CODES.InvalidParams &&
      listed !== undefined &&
      typeof data.requested === "string");
  if (!aboutVersion) return undefined;
  return (listed ?? []).filter(
    (version): version is string => typeof version === "string"
  );
}
