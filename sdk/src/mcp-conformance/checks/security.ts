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
  failedResult,
  notApplicableResult,
  passedResult,
} from "./helpers.js";
import { planHandshakeFollowUp } from "./security-handshake.js";

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
  timeoutMs: number;
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
 * One hand-built request over `node:http`. `fetch` forbids setting `Host`,
 * which the host-header probes have to forge, so everything these checks send
 * goes through here.
 */
async function sendRaw(
  serverUrl: string,
  options: RawSendOptions,
): Promise<RawHttpResponse> {
  const target = new URL(serverUrl);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body =
    options.message === undefined ? undefined : JSON.stringify(options.message);

  return await new Promise<RawHttpResponse>((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
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
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: undefined,
            bodyText: "",
          });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: parseResponseBody(bodyText),
            bodyText,
          });
        });
      },
    );

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`));
    });
    req.on("error", reject);
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
): Promise<RawHttpResponse> {
  return await sendRaw(serverUrl, {
    method: "POST",
    headers,
    timeoutMs,
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

/**
 * Finish the handshake the valid-host probe opened, then close its session.
 *
 * The probe is a session of its own: it is built by hand, so the normal client
 * never sees it and never completes it. "After successful initialization, the
 * client MUST send an `initialized` notification", so this sends it, with the
 * same Host and Origin the probe used, and then a DELETE when the server gave a
 * session id.
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
  if (plan.kind === "none") {
    return {
      initialized: "not sent",
      reason:
        plan.reason === "refused"
          ? "The server did not accept initialize, so there was no handshake to finish."
          : "The initialize answer carried no result, so initialization was not confirmed.",
    };
  }

  const outcome: Record<string, unknown> = {};
  const sessionHeaders = {
    ...probeHeaders,
    // The version header rides on every request after initialize and carries
    // the version the server agreed to.
    "mcp-protocol-version":
      plan.kind === "complete" ? plan.protocolVersion : plan.answeredVersion,
    ...(plan.sessionId ? { "mcp-session-id": plan.sessionId } : {}),
  };

  if (plan.kind === "complete") {
    try {
      const response = await sendRaw(ctx.serverUrl, {
        method: "POST",
        headers: sessionHeaders,
        message: { jsonrpc: "2.0", method: "notifications/initialized" },
        timeoutMs: ctx.config.checkTimeout,
        statusOnly: true,
      });
      outcome.initialized = "sent";
      outcome.initializedStatus = response.statusCode;
    } catch (error) {
      ctx.config.signal?.throwIfAborted();
      outcome.initialized = "not delivered";
      outcome.initializedError =
        error instanceof Error ? error.message : String(error);
    }
  } else {
    outcome.initialized = "not sent";
    outcome.reason = `The server answered initialize with protocol version "${plan.answeredVersion}", which MCPJam does not support. A client should disconnect in that case.`;
  }

  if (plan.sessionId) {
    try {
      const response = await sendRaw(ctx.serverUrl, {
        method: "DELETE",
        headers: sessionHeaders,
        timeoutMs: ctx.config.checkTimeout,
        statusOnly: true,
      });
      outcome.sessionCloseStatus = response.statusCode;
    } catch (error) {
      // Closing is best effort: a server may answer 405, and one that drops
      // the connection has closed it anyway.
      ctx.config.signal?.throwIfAborted();
      outcome.sessionCloseError =
        error instanceof Error ? error.message : String(error);
    }
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
