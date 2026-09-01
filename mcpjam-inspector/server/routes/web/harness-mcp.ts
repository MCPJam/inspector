/**
 * Hosted-plane harness MCP proxy: `POST /api/web/harness-mcp/:serverId`.
 *
 * The Claude Code harness (in a cloud sandbox) speaks MCP JSON-RPC to THIS
 * route, which forwards to the user's real MCP server through MCPJam — so the
 * harness's MCP runs through the playground even in the horizontally-scaled
 * hosted plane. Auth is the **signed proxy token** (NOT a browser bearer): it
 * carries the acting user's delegated identity, which we hand to the existing
 * `workos_api_key` acting-as path so the per-request `createAuthorizedManager`
 * rebuilds the user's authorized connection server-side. Stateless — any
 * instance serves it.
 *
 * Mounted WITHOUT `bearerAuthMiddleware` (the token is the auth);
 * `sessionAuthMiddleware` already bypasses `/api/web/*`.
 *
 * Transport: mirrors `adapter-http`'s raw-spec shape that the Phase-0 spike
 * proved Claude Code's `type:"http"` client speaks — POST → single
 * `application/json`; the optional GET returns a minimal server-stream the
 * client probes then closes; no `Mcp-Session-Id` (stateless).
 */
import { Hono } from "hono";
import "../../types/hono";
import {
  handleJsonRpc,
  parseAndValidateJsonRpc,
} from "../../services/mcp-http-bridge";
import {
  createAuthorizedManager,
  withManager,
  type ManagerCallerContext,
} from "./auth";
import { verifyHarnessProxyToken } from "../../utils/harness/harness-proxy-token";
import { unsealHarnessProxyToken } from "../../utils/harness/harness-proxy-policy-seal";
import { evaluateHarnessProxyToolPolicy } from "../../utils/harness/harness-proxy-policy-enforcement";
import {
  buildCrossInstanceHarnessPolicyBlockMessage,
  publishHarnessPolicyBlock,
  type HarnessPolicyBlockEvent,
} from "../../utils/harness/harness-policy-block-channel.js";
import { rpcLogBus } from "../../services/rpc-log-bus";
import {
  enqueueHarnessRpcLog,
  flushHarnessRpcLogs,
  isRpcLogSinkConfigured,
} from "../../utils/harness/harness-rpc-log-sink";
import { logger } from "../../utils/logger";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { HOSTED_MODE } from "../../config.js";
import {
  HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER,
  HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY,
  buildCrossInstanceHarnessScopeStepUpMessage,
  normalizeHarnessScopeStepUpCorrelationId,
  publishHarnessScopeStepUp,
} from "../../utils/harness/harness-scope-step-up.js";
import { scopeStepUpInfoFromToolError } from "../../utils/insufficient-scope-step-up.js";
import { createRequestStreamFailureReporter } from "../../utils/stream-failure-reporter.js";
import { randomUUID } from "node:crypto";
import { isCallToolResultError } from "@mcpjam/sdk";
import { HARNESS_EVIDENCE_TURN_HEADER } from "../../utils/harness/mcp-config.js";
import {
  createConvexEvidenceTransport,
  createHarnessEvidenceClient,
  isHarnessEvidenceConfigured,
} from "../../utils/harness/harness-evidence-client.js";
import type { ToolCallEvidenceHook } from "../../services/mcp-http-bridge.js";

const harnessMcp = new Hono();

/** Per-request connect timeout for the authorized manager. */
const HARNESS_MCP_TIMEOUT_MS = 30_000;
/** Hard cap on the probe GET event-stream so a forgotten stream can't leak. */
const HARNESS_MCP_STREAM_MAX_MS = 10 * 60_000;
/** Lightweight fixed-window rate limit per (user, server). */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 600;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const CROSS_INSTANCE_SCOPE_STEP_UP_DELIVERY_GRACE_MS = 1250;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    // Opportunistic prune so the map can't grow unbounded.
    if (rateBuckets.size > 5000) {
      for (const [k, b] of rateBuckets)
        if (now >= b.resetAt) rateBuckets.delete(k);
    }
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX_PER_WINDOW;
}

/**
 * HEADER-ONLY (Phase 4 hardening): the token must arrive as
 * `X-MCPJam-Proxy-Token`. The old `?t=` query fallback is removed — tokens in
 * URLs leak into relay/edge/access logs. (The tunnel's own `?k=` secret is a
 * separate, edge-consumed credential and is untouched.)
 */
function readProxyToken(c: any): string | undefined {
  return c.req.header("x-mcpjam-proxy-token") || undefined;
}

function readScopeStepUpCorrelationId(c: any): string | undefined {
  return normalizeHarnessScopeStepUpCorrelationId(
    c.req.header(HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER) ??
      c.req.query(HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY)
  );
}

/**
 * The turn a proxied call belongs to.
 *
 * Bounded, and bounded because it is caller-supplied: it only ever selects a
 * turn WITHIN the iteration the token's verified claim already authorizes, so
 * the worst a wrong value can do is file a row under a turn of the same
 * iteration. Length-capped so a hostile sandbox cannot make the row's index
 * key arbitrarily large.
 */
function readEvidenceTurnId(c: any): string | undefined {
  const raw = c.req.header(HARNESS_EVIDENCE_TURN_HEADER);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

/**
 * Arm evidence capture for this request, or return `undefined` to leave the
 * bridge's hook inert.
 *
 * Three things must all be true, and each absence is a different, legitimate
 * case rather than an error: the token carries an AUTHORIZED eval scope (not
 * playground traffic), the harness named a turn, and this deployment can
 * actually reach the evidence routes. Anything else runs the proxy exactly as
 * it ran before evidence existed.
 */
function armToolCallEvidence(
  c: any,
  claims: { runId?: string; iterationId?: string }
): ToolCallEvidenceHook | undefined {
  if (!claims.runId || !claims.iterationId) return undefined;
  const turnId = readEvidenceTurnId(c);
  if (!turnId) return undefined;
  if (!isHarnessEvidenceConfigured()) {
    // The run's mint said capture is on and this instance cannot write. Loud,
    // because a silent skip is the failure mode the whole protocol exists to
    // prevent: the turn would record nothing and read afterwards as a turn
    // that made no tool calls.
    logger.error(
      "[harness-mcp] evidence-scoped token but no evidence transport configured",
      undefined,
      { iterationId: claims.iterationId, turnId }
    );
    return undefined;
  }

  const client = createHarnessEvidenceClient({
    scope: {
      runId: claims.runId,
      iterationId: claims.iterationId,
      turnId,
    },
    transport: createConvexEvidenceTransport(),
  });

  // One request id per proxied HTTP request. JSON-RPC batches are rejected
  // upstream (`parseAndValidateJsonRpc`), so one request is one `tools/call`,
  // and this id is both the idempotency key for start/settle replays and the
  // join key from a trace span back to its evidence row.
  const requestId = randomUUID();
  const startedAtMs = Date.now();

  return {
    beforeExecute: async ({ serverId, toolName, arguments: args }) => {
      const recorded = await client.recordStart({
        requestId,
        serverId,
        toolName,
        arguments: args,
        startedAtMs,
      });
      return recorded
        ? { ok: true }
        : {
            ok: false,
            reason:
              "MCPJam could not record this tool call, so it was not executed. No action was taken on the server.",
          };
    },
    afterExecute: async ({ outcome }) => {
      await client.recordSettlement({
        requestId,
        outcomeKind:
          outcome.kind === "error"
            ? "jsonrpc_error"
            : isCallToolResultError(outcome.result)
              ? "call_tool_error"
              : "success",
        response:
          outcome.kind === "error"
            ? serializeEvidenceError(outcome.error)
            : outcome.result,
        settledAtMs: Date.now(),
      });
    },
  };
}

/**
 * The JSON-RPC error envelope the bridge WILL generate for a thrown failure.
 *
 * Recorded rather than the raw exception: the evidence is meant to be the
 * outcome the harness saw, and what it sees is this envelope. Built here from
 * the same message the bridge uses, with the code it uses (-32000, "the tool
 * ran and failed").
 */
function serializeEvidenceError(error: unknown): unknown {
  return {
    error: {
      code: -32000,
      message:
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Tool call failed",
    },
  };
}

async function handle(c: any) {
  const serverId = c.req.param("serverId");

  // Token is REQUIRED here (unlike adapter-http's validate-when-present) — it
  // is the only auth on this route, and carries the delegated identity.
  //
  // A policied harness run sends the token SEALED (`mcpjps1.…`): the Convex
  // token enclosed by the run's resolved tool policy, so the sandbox cannot
  // strip the policy without losing the credential. Unsealing yields the inner
  // token, which still goes through the unchanged verifier — identity authority
  // stays Convex's. A bare token keeps today's path byte-for-byte.
  const presentedToken = readProxyToken(c);
  const sealed = unsealHarnessProxyToken(presentedToken, serverId);
  const claims = verifyHarnessProxyToken(
    sealed?.token ?? presentedToken,
    serverId
  );
  if (!claims || !claims.externalId || !claims.orgId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (rateLimited(`${claims.userId}:${serverId}`)) {
    return c.json({ error: "Rate limited" }, 429);
  }

  // Armed once per REQUEST, not per call: JSON-RPC batches are rejected
  // upstream, so one request is one `tools/call`, and the request id this
  // holds is what makes start/settle replays idempotent.
  const evidenceHook = armToolCallEvidence(c, claims);

  const method = c.req.method;

  // Optional GET server-stream: Claude Code opens it then (per Phase 0) closes
  // it. We have no persistent connection to relay from in this stateless route,
  // so return a minimal keep-alive event-stream and clean up on disconnect.
  if (method === "GET" || method === "HEAD") {
    if (method === "HEAD") {
      return c.body(null, 200, { "Content-Type": "text/event-stream" });
    }
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let killAt: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (killAt) clearTimeout(killAt);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`: ok\n\n`));
        timer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          } catch {}
        }, 15000);
        // Hard cap: never hold the stream open indefinitely.
        killAt = setTimeout(() => {
          cleanup();
          try {
            controller.close();
          } catch {}
        }, HARNESS_MCP_STREAM_MAX_MS);
      },
      cancel() {
        cleanup();
      },
    });
    return c.body(stream as any, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }

  if (method !== "POST") {
    return c.json({ error: "Unsupported request" }, 400);
  }

  // Malformed payloads must NOT fall through to the notification → 202 path
  // (the bridge treats a missing method as a notification): a garbage body
  // acknowledged as "Accepted" looks like a delivered message to the harness.
  // Shared with the local MCP proxy (`http-adapters`) via the bridge helper.
  const validation = await parseAndValidateJsonRpc(() => c.req.json());
  if (!validation.ok) {
    return c.json(validation.response, validation.status as 400);
  }
  const body = validation.body;

  // Rebuild the user's authorized connection server-side via the acting-as
  // service-token exchange (no browser bearer in the sandbox). Convex baked the
  // verified identity into the token; Convex also access-checked the server at
  // mint time, so membership authorization here is the project-ownership path.
  const caller: ManagerCallerContext = {
    authMethod: "workos_api_key",
    workosUserId: claims.externalId,
    mcpjamOrganizationId: claims.orgId,
  };

  try {
    const response = await withManager(
      createAuthorizedManager(
        caller,
        "", // bearer ignored on the workos_api_key path
        claims.projectId,
        [serverId],
        HARNESS_MCP_TIMEOUT_MS,
        undefined,
        undefined,
        {
          // Per-server XAA works on the harness proxy (configured servers
          // mint instead of 500ing). KNOWN LIMITATION: the host's
          // enterprise-managed POLICY is NOT enforced here — the harness
          // token's claims carry projectId/serverId but not the host, so an
          // unconfigured `auto` server on a policy host takes the discover
          // ladder in a harness turn instead of 409ing. Fix by threading the
          // host policy (or hostId) into the harness token claims.
          xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
          // Publish the sandbox's MCP traffic into the in-process rpc-log bus
          // so a live harness turn ON THIS INSTANCE can forward it into the
          // Playground Logs panel (see bridgeHarnessRpcLogsToCollector), and
          // the local-mode Logs SSE/buffer sees it too. Observation-only —
          // never affects the proxy result: the bus isolates subscribers, and
          // this guard is the belt-and-suspenders so no logging failure can
          // reach the RPC try/catch below.
          //
          // COMP-21: ALSO enqueue the frame to the shared Convex sink (batched,
          // best-effort) so a turn streaming from ANOTHER instance can pull it —
          // cross-instance fan-in on the scaled hosted plane. The enqueue never
          // throws to here (own try/catch inside), and the sink no-ops when
          // Convex isn't configured (single-instance / self-hosted).
          rpcLogger: ({ direction, message, serverId: sid }) => {
            const timestamp = new Date().toISOString();
            try {
              rpcLogBus.publish({
                serverId: sid,
                direction,
                timestamp,
                message,
              });
            } catch (error) {
              logger.warn(
                `[harness-mcp] rpc log publish failed serverId=${sid}: ${
                  error instanceof Error ? error.message : error
                }`
              );
            }
            enqueueHarnessRpcLog({
              serverId: sid,
              projectId: claims.projectId,
              organizationId: claims.orgId,
              direction,
              loggedAt: timestamp,
              message,
            });
          },
          // The header half of the same traffic, onto the same bus. Without
          // this a harness turn's Logs panel shows frames and no headers,
          // which from 2026-07-28 is the half that explains a
          // `-32020 HeaderMismatch`. Same observation-only contract as
          // `rpcLogger`: guarded, and a failure can never reach the RPC.
          //
          // NOT enqueued to the Convex sink: that shape carries JSON-RPC
          // frames only, so cross-instance harness turns still get frames
          // without headers. Widening the sink is a backend change; this at
          // least closes the same-instance case rather than leaving the bus
          // branch unexercised.
          httpLogger: (exchange) => {
            try {
              rpcLogBus.publish({
                kind: "http",
                serverId: exchange.serverId,
                timestamp: new Date().toISOString(),
                exchange,
              });
            } catch (error) {
              logger.warn(
                `[harness-mcp] http log publish failed serverId=${
                  exchange.serverId
                }: ${error instanceof Error ? error.message : error}`
              );
            }
          },
        }
      ),
      async (manager) => {
        // Enforce `toolPolicy` BEFORE the bridge: a denied call must never
        // reach `executeTool`. Only `tools/call` is gated, `tools/list` stays
        // unfiltered, and a block is a success envelope carrying the marker —
        // see `harness-proxy-policy-enforcement.ts`.
        if (sealed) {
          const block = evaluateHarnessProxyToolPolicy({
            body,
            policyServerId: serverId,
            policy: sealed.policy,
            hasServer: (id) => manager.hasServer(id),
          });
          if (block) {
            logger.info(
              `[harness-mcp] tool policy blocked serverId=${serverId} tool=${block.marker.toolName} reason=${block.marker.reason}`
            );
            // Report the refusal to the RUN, not just to the model: the harness
            // adapter flattens this result's content blocks to a bare string, so
            // the `_meta` marker cannot be the accounting mechanism. The proxy
            // knows it blocked — deliver that on the same channel a
            // cross-instance scope step-up uses, correlated by the turn id every
            // generated `.mcp.json` entry already carries.
            const event: HarnessPolicyBlockEvent = {
              serverId,
              toolName: block.marker.toolName,
              reason: block.marker.reason,
              classification: block.marker.classification,
              at: Date.now(),
            };
            const correlationId = readScopeStepUpCorrelationId(c);
            const deliveredLocally = publishHarnessPolicyBlock(
              correlationId,
              event
            );
            if (
              !deliveredLocally &&
              correlationId &&
              isRpcLogSinkConfigured()
            ) {
              const relay = buildCrossInstanceHarnessPolicyBlockMessage(
                correlationId,
                event
              );
              if (relay) {
                enqueueHarnessRpcLog({
                  serverId,
                  projectId: claims.projectId,
                  organizationId: claims.orgId,
                  direction: "receive",
                  loggedAt: new Date().toISOString(),
                  message: relay,
                });
                // Flush now rather than on the ~1s batch timer: the turn may
                // finish before a batched frame would ever be written.
                await flushHarnessRpcLogs();
              }
            }
            return block.response;
          }
        }
        return handleJsonRpc(serverId, body, manager, "adapter", {
          // Inert unless this token carries an authorized eval scope AND the
          // harness named a turn — so playground traffic and capture-off runs
          // pay nothing and behave identically.
          ...(evidenceHook ? { toolCallEvidence: evidenceHook } : {}),
          // Bridge failures answer 200 with a JSON-RPC error envelope —
          // invisible to http.request.failed; this is their typed record.
          failureReporter: createRequestStreamFailureReporter(
            c,
            "harness-mcp",
          ),
          onToolCallError: async (context) => {
            const info = scopeStepUpInfoFromToolError(context);
            if (!info) return;
            const event = {
              ...info,
              ...(context.toolName ? { toolName: context.toolName } : {}),
              ...(Object.prototype.hasOwnProperty.call(context, "toolInput")
                ? { toolInput: context.toolInput }
                : {}),
            };
            const correlationId = readScopeStepUpCorrelationId(c);
            const deliveredLocally = publishHarnessScopeStepUp(
              correlationId,
              event
            );
            if (
              deliveredLocally ||
              !correlationId ||
              !isRpcLogSinkConfigured()
            ) {
              return;
            }

            const relay = buildCrossInstanceHarnessScopeStepUpMessage(
              correlationId,
              event
            );
            if (!relay) return;
            enqueueHarnessRpcLog({
              serverId,
              projectId: claims.projectId,
              organizationId: claims.orgId,
              direction: "receive",
              loggedAt: new Date().toISOString(),
              message: relay,
            });
            await flushHarnessRpcLogs();
            // The live turn polls once per second. Hold only this actionable
            // error response briefly so the remote replica can suspend before
            // the harness sees a failure and asks the model to narrate it.
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                CROSS_INSTANCE_SCOPE_STEP_UP_DELIVERY_GRACE_MS
              )
            );
          },
        });
      }
    );
    // Notification (no id) → 202 Accepted, no body.
    if (!response) return c.body("Accepted", 202);
    return c.json(response);
  } catch (e: any) {
    // Report the real cause server-side (classified — the old bare
    // logger.error paged Sentry unconditionally), but NEVER leak internal
    // exception text to the sandbox — return a generic JSON-RPC error so the
    // client can recover. HTTP status stays 200, so this reporter call is
    // the failure's only typed record.
    try {
      createRequestStreamFailureReporter(c, "harness-mcp")({
        message: `[harness-mcp] proxy error serverId=${serverId}`,
        error: e,
        source: "web.harness-mcp.proxy",
        hop: "user_server_hop",
        transport: "rpc_envelope",
        // The masked response below is always a -32000; carry it so these
        // stay queryable alongside the bridge's own failures.
        errorCode: "-32000",
        context: { serverId },
      });
    } catch {
      // Telemetry must never change the masked response.
    }
    return c.json(
      {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32000, message: "harness proxy error" },
      },
      200
    );
  }
}

harnessMcp.all("/:serverId", handle);
harnessMcp.all("/:serverId/*", handle);

export { harnessMcp };
