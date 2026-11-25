import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import {
  eraSkipMessage,
  errorMessage,
  failedResult,
  notApplicableResult,
  passedResult,
} from "./helpers.js";
import { isEventStream, parseSseEvents } from "../raw-capture.js";
import {
  followUpTimeoutMs,
  planHandshakeFollowUp,
} from "./security-handshake.js";

const LOCALHOST_SECURITY_CHECK_IDS = [
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
] as const;

type RawHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: unknown;
  /** The response body, verbatim. Empty for a `statusOnly` request. */
  bodyText: string;
};

interface RawSendOptions {
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  /** The JSON-RPC message to send. Left out for a request with no body. */
  message?: unknown;
  /** A limit on the whole exchange, not on the gap between two chunks. */
  timeoutMs: number;
  /** Stops the request when the run is cancelled. */
  signal?: AbortSignal;
  /**
   * Settle on the status line and drop the connection without reading the
   * body. For the requests that close the handshake, where only "did it
   * arrive" matters: a server that answers a notification with a stream that
   * never ends must not hold the check until its timeout.
   */
  statusOnly?: boolean;
}

// Exported so `tests/conformance-catalog.test.ts` can assert the browser-safe
// catalog still matches these canonical strings.
export const SECURITY_CHECK_METADATA = {
  "localhost-host-rebinding-rejected": {
    id: "localhost-host-rebinding-rejected",
    category: "security",
    title: "Reject Evil Host Header",
    description:
      "Local servers reject initialize requests with a non-localhost Host/Origin header.",
  },
  "localhost-host-valid-accepted": {
    id: "localhost-host-valid-accepted",
    category: "security",
    title: "Accept Valid Local Host Header",
    description:
      "Local servers accept initialize requests with a valid localhost Host/Origin header.",
  },
} as const satisfies Record<
  Extract<
    MCPCheckId,
    "localhost-host-rebinding-rejected" | "localhost-host-valid-accepted"
  >,
  Pick<MCPCheckResult, "id" | "category" | "title" | "description">
>;

function isLocalhostUrl(serverUrl: string): boolean {
  const hostname = new URL(serverUrl).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function getHostFromUrl(serverUrl: string): string {
  return new URL(serverUrl).host;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Whether an event stream already carries the answer to request `id`. A
 * server may keep the stream open after it (with comments, or with nothing),
 * and a client that has its answer does not wait for the end.
 */
function answeredOnStream(bodyText: string, id: unknown): boolean {
  return parseSseEvents(bodyText).some((event) => {
    if (!event.terminated) return false;
    const message = event.json;
    return (
      message !== null &&
      typeof message === "object" &&
      (message as { id?: unknown }).id === id &&
      ("result" in message || "error" in message)
    );
  });
}

/**
 * One hand-built request over `node:http`. `fetch` forbids setting `Host`,
 * which the host-header probes have to forge, so everything these checks send
 * goes through here.
 *
 * It always settles: on the answer, on the end of the body, on a connection
 * that drops before the end, on a cancel, or at `timeoutMs`.
 */
async function sendRaw(
  serverUrl: string,
  options: RawSendOptions,
): Promise<RawHttpResponse> {
  const target = new URL(serverUrl);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body =
    options.message === undefined ? undefined : JSON.stringify(options.message);
  const requestId =
    options.message !== null && typeof options.message === "object"
      ? (options.message as { id?: unknown }).id
      : undefined;

  return await new Promise<RawHttpResponse>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outcome();
    };
    const req = requestImpl(
      {
        protocol: target.protocol,
        // `URL` keeps the brackets of an IPv6 literal; the resolver wants none.
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        signal: options.signal,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Accept: "application/json, text/event-stream",
          ...(body === undefined
            ? {}
            : { "Content-Length": String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
      },
      (res) => {
        if (options.statusOnly) {
          settle(() =>
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: undefined,
              bodyText: "",
            }),
          );
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        const stream = isEventStream(String(res.headers["content-type"] ?? ""));
        const answered = () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          settle(() =>
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: parseResponseBody(bodyText),
              bodyText,
            }),
          );
        };
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          if (
            stream &&
            requestId !== undefined &&
            answeredOnStream(Buffer.concat(chunks).toString("utf8"), requestId)
          ) {
            answered();
            res.destroy();
          }
        });
        res.on("end", answered);
        // `close` after `end` finds the promise settled and does nothing.
        res.on("close", () =>
          settle(() =>
            reject(
              new Error("The connection closed before the response ended"),
            ),
          ),
        );
      },
    );

    const deadline = setTimeout(() => {
      settle(() =>
        reject(new Error(`Request timed out after ${options.timeoutMs}ms`)),
      );
      req.destroy();
    }, options.timeoutMs);
    req.on("error", (error) => settle(() => reject(error)));
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function sendRequest(
  serverUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  protocolVersion: string,
  signal?: AbortSignal,
): Promise<RawHttpResponse> {
  return await sendRaw(serverUrl, {
    method: "POST",
    headers,
    timeoutMs,
    signal,
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "mcpjam-sdk-conformance",
          version: "1.0.0",
        },
      },
    },
  });
}

/** Why no notification followed an `initialize` answer, for the details. */
const NOT_SENT_REASON = {
  refused:
    "The server did not accept initialize, so there was no handshake to finish.",
  "error-answer":
    "The server answered initialize with a JSON-RPC error, so the handshake was not finished.",
  "no-result":
    "The initialize answer carried no result, so initialization was not confirmed.",
} as const;

/**
 * Finish the handshake the valid-host probe opened, then close its session.
 *
 * The probe is a session of its own: it is built by hand, so the normal client
 * never sees it and never completes it. "After successful initialization, the
 * client MUST send an `initialized` notification", so this sends it, with the
 * same Host and Origin the probe used, and then a DELETE when the server gave a
 * session id. A session an unsuccessful 2xx answer opened is closed as well.
 *
 * Returns what happened, for the check's details. It never changes the
 * verdict: the check is about whether the server accepted a valid Host, and
 * that was decided by the `initialize` answer.
 *
 * NOT called for the rebinding probe. That one sends a bad Host on purpose and
 * expects to be refused; there is no handshake to finish.
 */
async function finishHandshake(
  ctx: RawHttpCheckContext,
  probeHeaders: Record<string, string>,
  answer: RawHttpResponse,
  requestedVersion: string,
): Promise<Record<string, unknown>> {
  const plan = planHandshakeFollowUp(answer, requestedVersion);
  const outcome: Record<string, unknown> = {};
  const sessionHeaders = {
    ...probeHeaders,
    // The version the run asked for. On a disconnect the server's own answer
    // is not used: it is a version the run does not speak, and a server can
    // put anything in it, including what is not a legal header value.
    "mcp-protocol-version": requestedVersion,
    ...(plan.sessionId ? { "mcp-session-id": plan.sessionId } : {}),
  };
  /** One best-effort request. Not sent, and not caught, once the run is cancelled. */
  const followUp = async (
    method: "POST" | "DELETE",
    message?: unknown,
  ): Promise<{ status: number } | { error: string }> => {
    ctx.config.signal?.throwIfAborted();
    try {
      const response = await sendRaw(ctx.serverUrl, {
        method,
        headers: sessionHeaders,
        message,
        timeoutMs: followUpTimeoutMs(ctx.config.checkTimeout),
        signal: ctx.config.signal,
        statusOnly: true,
      });
      return { status: response.statusCode };
    } catch (error) {
      ctx.config.signal?.throwIfAborted();
      return { error: errorMessage(error) };
    }
  };

  if (plan.kind === "complete") {
    const sent = await followUp("POST", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    if ("status" in sent) {
      outcome.initialized = "sent";
      outcome.initializedStatus = sent.status;
    } else {
      outcome.initialized = "not delivered";
      outcome.initializedError = sent.error;
    }
  } else {
    outcome.initialized = "not sent";
    outcome.reason =
      plan.kind === "disconnect"
        ? `The server answered initialize with protocol version ${JSON.stringify(plan.answeredVersion)}, not the ${requestedVersion} this run uses, so the client disconnects.`
        : NOT_SENT_REASON[plan.reason];
  }

  if (plan.sessionId) {
    // Closing is best effort: a server may answer 405, and one that drops
    // the connection has closed it anyway.
    const closed = await followUp("DELETE");
    if ("status" in closed) outcome.sessionCloseStatus = closed.status;
    else outcome.sessionCloseError = closed.error;
  }
  return outcome;
}

function buildBaseHeaders(ctx: RawHttpCheckContext): Record<string, string> {
  return {
    ...(ctx.config.customHeaders ?? {}),
    ...(ctx.config.accessToken
      ? { Authorization: `Bearer ${ctx.config.accessToken}` }
      : {}),
  };
}

export async function runSecurityChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  ctx.config.signal?.throwIfAborted();
  const results: MCPCheckResult[] = [];

  if (
    !selectedCheckIds.has("localhost-host-rebinding-rejected") &&
    !selectedCheckIds.has("localhost-host-valid-accepted")
  ) {
    return results;
  }

  // Era gate (CHECK_ERAS is the single source of truth): the raw host-header
  // probes are legacy-only, so on a modern run they surface as skips — never
  // as a false failure — before any HTTP is attempted.
  const applicable = new Set<MCPCheckId>();
  for (const id of LOCALHOST_SECURITY_CHECK_IDS) {
    if (!selectedCheckIds.has(id)) {
      continue;
    }
    if (CHECK_ERAS[id].includes(ctx.config.era)) {
      applicable.add(id);
    } else {
      results.push(
        notApplicableResult(
          SECURITY_CHECK_METADATA[id],
          eraSkipMessage(ctx.config.era, ctx.config.protocolVersion),
        ),
      );
    }
  }

  if (applicable.size === 0) {
    return results;
  }

  const protocolVersion = ctx.config.protocolVersion ?? "2025-11-25";

  if (!isLocalhostUrl(ctx.serverUrl)) {
    for (const id of LOCALHOST_SECURITY_CHECK_IDS) {
      if (applicable.has(id)) {
        results.push(
          notApplicableResult(
            SECURITY_CHECK_METADATA[id],
            "Security host-header checks only apply to localhost servers",
            {
              serverUrl: ctx.serverUrl,
            },
          ),
        );
      }
    }

    return results;
  }

  const baseHeaders = buildBaseHeaders(ctx);
  const validHost = getHostFromUrl(ctx.serverUrl);

  if (applicable.has("localhost-host-rebinding-rejected")) {
    const startedAt = Date.now();
    try {
      const response = await sendRequest(
        ctx.serverUrl,
        {
          ...baseHeaders,
          Host: "evil.example.com",
          Origin: "http://evil.example.com",
        },
        ctx.config.checkTimeout,
        protocolVersion,
        ctx.config.signal,
      );
      // 2025-11-25 sharpened the requirement (changelog PR #1439): "If the
      // Origin header is present and invalid, servers MUST respond with HTTP
      // 403 Forbidden." The earlier revisions state the validation MUST but
      // name no status, so any 4xx satisfies them.
      //
      // Gated on an EXPLICIT pin, not on the resolved version: `protocolVersion`
      // falls back to 2025-11-25 to have something to put on the wire, and
      // letting that fallback also decide the assertion would newly fail an
      // unpinned run against a server that answers 400 — a run that asserted
      // nothing about which revision it was judging.
      const requires403 =
        ctx.config.protocolVersion !== undefined &&
        ctx.config.protocolVersion >= "2025-11-25";
      const rejected = requires403
        ? response.statusCode === 403
        : response.statusCode >= 400 && response.statusCode < 500;
      results.push(
        rejected
          ? passedResult(
              SECURITY_CHECK_METADATA["localhost-host-rebinding-rejected"],
              Date.now() - startedAt,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
              },
            )
          : failedResult(
              SECURITY_CHECK_METADATA["localhost-host-rebinding-rejected"],
              Date.now() - startedAt,
              requires403
                ? `Expected HTTP 403 Forbidden for an invalid Origin header (required since 2025-11-25), got ${response.statusCode}`
                : `Expected a 4xx response for invalid Host/Origin headers, got ${response.statusCode}`,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
              },
            ),
      );
    } catch (error) {
      ctx.config.signal?.throwIfAborted();
      results.push(
        failedResult(
          SECURITY_CHECK_METADATA["localhost-host-rebinding-rejected"],
          Date.now() - startedAt,
          error instanceof Error ? error.message : String(error),
          undefined,
          error,
        ),
      );
    }
  }

  if (applicable.has("localhost-host-valid-accepted")) {
    const startedAt = Date.now();
    try {
      const probeHeaders = {
        ...baseHeaders,
        Host: validHost,
        Origin: `http://${validHost}`,
      };
      const response = await sendRequest(
        ctx.serverUrl,
        probeHeaders,
        ctx.config.checkTimeout,
        protocolVersion,
        ctx.config.signal,
      );
      const accepted =
        response.statusCode >= 200 && response.statusCode < 300;
      // The verdict is settled here. What follows only ends the session this
      // probe opened, the way any client would.
      const durationMs = Date.now() - startedAt;
      const handshake = await finishHandshake(
        ctx,
        probeHeaders,
        response,
        protocolVersion,
      );
      results.push(
        accepted
          ? passedResult(
              SECURITY_CHECK_METADATA["localhost-host-valid-accepted"],
              durationMs,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
                handshake,
              },
            )
          : failedResult(
              SECURITY_CHECK_METADATA["localhost-host-valid-accepted"],
              durationMs,
              `Expected a 2xx response for valid localhost headers, got ${response.statusCode}`,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
                handshake,
              },
            ),
      );
    } catch (error) {
      ctx.config.signal?.throwIfAborted();
      results.push(
        failedResult(
          SECURITY_CHECK_METADATA["localhost-host-valid-accepted"],
          Date.now() - startedAt,
          error instanceof Error ? error.message : String(error),
          undefined,
          error,
        ),
      );
    }
  }

  return results;
}
