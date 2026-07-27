/**
 * `subscriptions.ts` (web) — the HOSTED passthrough route for MCP 2026-07-28
 * `subscriptions/listen` (spec §13.4).
 *
 * ## Shape
 *
 * A single authenticated endpoint, `POST /api/web/subscriptions/listen`. The
 * browser sends `{ projectId, serverId, desired }` (plus the usual host pins);
 * the replica authorizes + connects EXACTLY like an ordinary hosted op (reusing
 * `createManualHostedConnection` → `createAuthorizedManager` → the Convex
 * authorize batch), opens a DEDICATED official-client connection, and drives the
 * SDK's era-neutral `SubscriptionCoordinator`. Acknowledgement, notifications,
 * lifecycle status, and *safe* errors are forwarded downstream over SSE.
 *
 * ## Invariants this route is responsible for (see §13.4 / §5.5)
 *
 * - **Same replica for the shared lifetime.** The downstream browser stream and
 *   the upstream MCP subscription live on THIS replica together. We never write
 *   notifications to Convex to cross replicas — that is what makes the route
 *   horizontally scalable.
 * - **Abort cancels upstream + disposes the manager in `finally`.** A browser
 *   hang-up aborts `c.req.raw.signal`; the driver disposes the coordinator
 *   (cancelling the upstream listen) and the session `finally` disconnects the
 *   manager. No leaked upstream stream, ever.
 * - **Structured terminal event.** Graceful (server completed) vs remote
 *   (unexpected loss) vs local-abort vs error are DISTINCT terminal reasons.
 *   The coordinator is configured with `reconnect: { maxAttempts: 0 }` so a
 *   remote loss closes downstream rather than silently re-listening server-side
 *   — the browser re-opens from the desired filter (there is NO replay).
 * - **Authorization + a concurrent-stream limit.** Authorization is the same
 *   fail-closed batch every hosted op runs (per user/project/server). On top of
 *   that a practical per-actor concurrent-stream cap protects the replica from
 *   an unbounded number of long-lived upstream connections.
 * - **Telemetry without payloads.** Stream duration + close reason go to Axiom;
 *   aggregate feature usage goes to PostHog. Neither carries notification
 *   payloads.
 *
 * ## Testability
 *
 * The upstream-driving core (`driveHostedSubscription`) and the
 * session-lifecycle core (`runHostedSubscriptionSession`) are pure and take an
 * injectable seam bag, so route-level tests drive the REAL coordinator over a
 * fake `SubscriptionClientPort` and a fake sink without a live Convex/MCP.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  SubscriptionCoordinator,
  type DesiredSubscriptionInterests,
  type MCPClientManager,
  type SubscriptionClientPort,
  type SubscriptionCoordinatorOptions,
  type SubscriptionStreamRecord,
} from "@mcpjam/sdk";
import type {
  HostedSubscriptionEvent,
  SubscriptionCloseReasonView,
  SubscriptionEra,
  SubscriptionNotificationView,
  SubscriptionRejectedNotificationView,
  SubscriptionStreamView,
} from "@/shared/hosted-subscription.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { captureServerEvent } from "../../utils/analytics.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import { logger } from "../../utils/logger.js";
import {
  ErrorCode,
  WebRouteError,
  webError,
  mapRuntimeError,
  readJsonBody,
} from "./errors.js";
import {
  createManualHostedConnection,
  projectServerSchema,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const desiredSchema = z
  .object({
    toolsListChanged: z.boolean().optional(),
    promptsListChanged: z.boolean().optional(),
    resourcesListChanged: z.boolean().optional(),
    resourceUris: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Single-server (`projectServerSchema` carries `serverId`) plus the desired
 * interests. `desired` is the era-neutral statement of what the user wants to
 * observe; the coordinator turns it into either a modern `subscriptions/listen`
 * filter or legacy per-URI `resources/subscribe` calls.
 */
export const hostedSubscriptionSchema = projectServerSchema.extend({
  desired: desiredSchema.optional(),
});

// ---------------------------------------------------------------------------
// Concurrent-stream limit (per actor, this replica)
// ---------------------------------------------------------------------------

/**
 * Max long-lived subscription streams a single actor may hold open on ONE
 * replica at once. A subscription stream pins an upstream MCP connection for its
 * whole lifetime, so this is a resource cap, not a rate limit. Deliberately
 * generous (a debugger legitimately watches several servers) but finite.
 */
export const MAX_CONCURRENT_SUBSCRIPTION_STREAMS = 8;

/** actorKey -> live stream count on this replica. */
const activeStreamCounts = new Map<string, number>();

export function activeSubscriptionStreamCount(actorKey: string): number {
  return activeStreamCounts.get(actorKey) ?? 0;
}

/** Reserve a slot; returns false when the actor is already at the cap. */
export function acquireSubscriptionStreamSlot(actorKey: string): boolean {
  const current = activeStreamCounts.get(actorKey) ?? 0;
  if (current >= MAX_CONCURRENT_SUBSCRIPTION_STREAMS) return false;
  activeStreamCounts.set(actorKey, current + 1);
  return true;
}

export function releaseSubscriptionStreamSlot(actorKey: string): void {
  const current = activeStreamCounts.get(actorKey) ?? 0;
  if (current <= 1) {
    activeStreamCounts.delete(actorKey);
    return;
  }
  activeStreamCounts.set(actorKey, current - 1);
}

/** Test seam: forget every reserved slot. */
export function resetSubscriptionStreamSlots(): void {
  activeStreamCounts.clear();
}

/**
 * The concurrency key is the authenticated actor (WorkOS user id for signed-in
 * users, guest id for guests), resolved from the request log context the
 * authorize exchange populates. Falls back to a per-request-unique token so an
 * unresolved actor can still open a single stream but can never share a bucket
 * with anyone else.
 */
export function resolveSubscriptionActorKey(c: {
  var?: { requestLogContext?: RequestLogContext };
  get?: (k: string) => unknown;
}): string {
  const ctx = c.var?.requestLogContext;
  const external =
    ctx?.userExternalId ??
    ctx?.guestExternalId ??
    (typeof c.get?.("guestId") === "string"
      ? (c.get!("guestId") as string)
      : undefined);
  return external ?? `anon:${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// View mappers (record -> wire view). Mirror the LOCAL bridge's shapes.
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<SubscriptionStreamRecord["status"]> =
  new Set(["graceful-closed", "remote-closed", "cancelled", "error"]);

export function isTerminalSubscriptionStatus(
  status: SubscriptionStreamRecord["status"],
): boolean {
  return TERMINAL_STATUSES.has(status);
}

function toStreamView(stream: SubscriptionStreamRecord): SubscriptionStreamView {
  return {
    localId: stream.localId,
    era: stream.era,
    ...(stream.mcpSubscriptionId
      ? { mcpSubscriptionId: stream.mcpSubscriptionId }
      : {}),
    ...(stream.idBinding ? { idBinding: stream.idBinding } : {}),
    requestedFilter: { ...stream.requestedFilter },
    ...(stream.acknowledgedFilter
      ? { acknowledgedFilter: { ...stream.acknowledgedFilter } }
      : {}),
    rejectedInterests: stream.rejectedInterests.map((r) => ({ ...r })),
    status: stream.status,
    ...(stream.closeReason ? { closeReason: stream.closeReason } : {}),
    ...(stream.error ? { error: stream.error } : {}),
    openedAt: stream.openedAt,
    ...(stream.acknowledgedAt ? { acknowledgedAt: stream.acknowledgedAt } : {}),
    ...(stream.closedAt ? { closedAt: stream.closedAt } : {}),
    reconnectAttempt: stream.reconnectAttempt,
  };
}

// ---------------------------------------------------------------------------
// SSE sink + driver
// ---------------------------------------------------------------------------

export interface SubscriptionSink {
  send(event: HostedSubscriptionEvent): void;
  close(): void;
}

/** Everything Axiom + PostHog need at close — never any notification payload. */
export interface HostedSubscriptionTerminalInfo {
  serverId: string;
  reason: SubscriptionCloseReasonView;
  era: SubscriptionEra;
  durationMs: number;
  notificationCount: number;
  reconnectAttempt: number;
  supportsListen: boolean;
}

export interface HostedSubscriptionSeams {
  /** Override the coordinator constructor (tests inject a fake-client driver). */
  coordinatorFactory?: (
    opts: SubscriptionCoordinatorOptions,
  ) => SubscriptionCoordinator;
  now?: () => number;
  /** Aggregate feature-usage capture (PostHog). Payload-free by contract. */
  captureOpen?: (info: {
    serverId: string;
    era: SubscriptionEra;
    supportsListen: boolean;
    transport: "http";
  }) => void;
  /** Stream duration + close reason (Axiom). Payload-free by contract. */
  recordClosed?: (info: HostedSubscriptionTerminalInfo) => void;
}

/**
 * Wires the era-neutral coordinator to the SSE sink and returns a promise that
 * resolves when the stream reaches a terminal state (graceful/remote/local-abort
 * /error) or the caller aborts. Registers the coordinator SYNCHRONOUSLY (its
 * notification handlers are bound inside `openModernStream` BEFORE the `listen`
 * RPC opens the upstream, so no notification can be missed) and configures
 * `maxAttempts: 0` so a remote loss surfaces downstream instead of silently
 * re-listening on the replica.
 */
export function driveHostedSubscription(args: {
  client: SubscriptionClientPort;
  serverId: string;
  desired: DesiredSubscriptionInterests;
  sink: SubscriptionSink;
  signal?: AbortSignal;
  seams?: HostedSubscriptionSeams;
}): {
  done: Promise<HostedSubscriptionTerminalInfo>;
  coordinator: SubscriptionCoordinator;
  era: SubscriptionEra;
  supportsListen: boolean;
} {
  const { client, serverId, desired, sink, signal, seams } = args;
  const now = seams?.now ?? (() => Date.now());
  const startedAt = now();
  const supportsListen = typeof client.listen === "function";

  let notificationCount = 0;
  let settled = false;
  let resolveDone!: (info: HostedSubscriptionTerminalInfo) => void;
  const done = new Promise<HostedSubscriptionTerminalInfo>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (
    reason: SubscriptionCloseReasonView,
    era: SubscriptionEra,
    reconnectAttempt: number,
  ) => {
    if (settled) return;
    settled = true;
    resolveDone({
      serverId,
      reason,
      era,
      durationMs: now() - startedAt,
      notificationCount,
      reconnectAttempt,
      supportsListen,
    });
  };

  const factory =
    seams?.coordinatorFactory ??
    ((opts: SubscriptionCoordinatorOptions) => new SubscriptionCoordinator(opts));

  const coordinator = factory({
    client,
    // Re-listen, never resume — but for the HOSTED passthrough a remote loss
    // closes downstream (the browser re-opens). Server-side re-listen is off.
    reconnect: { maxAttempts: 0 },
    ...(seams?.now ? { now: seams.now } : {}),
    onStreamChange: (stream) => {
      const view = toStreamView(stream);
      sink.send({ type: "stream", serverId, stream: view });
      if (isTerminalSubscriptionStatus(stream.status)) {
        const reason: SubscriptionCloseReasonView =
          stream.closeReason ?? "error";
        sink.send({
          type: "terminal",
          serverId,
          reason,
          era: stream.era,
          stream: view,
        });
        finish(reason, stream.era, stream.reconnectAttempt);
      }
    },
    onNotification: (event) => {
      notificationCount += 1;
      const notification: SubscriptionNotificationView = {
        method: event.method,
        kind: event.kind,
        ...(event.uri ? { uri: event.uri } : {}),
        ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
        localSubscriptionId: event.localSubscriptionId,
        at: event.at,
      };
      sink.send({ type: "notification", serverId, notification });
    },
    onRejectedNotification: (event) => {
      const rejection: SubscriptionRejectedNotificationView = {
        method: event.method,
        ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
        ...(event.localSubscriptionId
          ? { localSubscriptionId: event.localSubscriptionId }
          : {}),
        reason: event.reason,
        at: event.at,
      };
      sink.send({ type: "rejected", serverId, rejection });
    },
  });

  const era = coordinator.era;

  // Preamble: confirm acceptance + report era/support before any upstream work.
  sink.send({ type: "open", serverId, era, supportsListen });

  // Browser abort → dispose the coordinator (cancels the upstream listen). The
  // resulting `cancelled`/`local-abort` stream change resolves `done`; if the
  // coordinator never opened a stream (e.g. empty filter), settle explicitly so
  // the session `finally` still runs.
  const onAbort = () => {
    void coordinator.dispose().finally(() => finish("local-abort", era, 0));
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // Open the stream. A synchronous coordinator failure is surfaced as a terminal
  // stream change already; guard the promise so it can't become an unhandled
  // rejection.
  void coordinator.setDesiredInterests(desired).catch((error) => {
    logger.warn("[subscriptions.hosted] setDesiredInterests failed", {
      error,
      serverId,
    });
    finish("error", era, 0);
  });

  return { done, coordinator, era, supportsListen };
}

/**
 * Full session lifecycle over an already-connected manager: capture the open
 * feature-usage event, drive the stream to a terminal state, record the close,
 * and — CRITICALLY — dispose the manager in `finally` regardless of how the
 * stream ended (graceful, remote, abort, or throw).
 */
export async function runHostedSubscriptionSession(args: {
  manager: Pick<MCPClientManager, "getManagedClient" | "disconnectAllServers">;
  serverId: string;
  desired: DesiredSubscriptionInterests;
  sink: SubscriptionSink;
  signal?: AbortSignal;
  seams?: HostedSubscriptionSeams;
}): Promise<HostedSubscriptionTerminalInfo> {
  const { manager, serverId, desired, sink, signal, seams } = args;
  const client = manager.getManagedClient(serverId) as
    | SubscriptionClientPort
    | undefined;
  if (!client) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `Server "${serverId}" is not connected`,
    );
  }

  const { done, era, supportsListen } = driveHostedSubscription({
    client,
    serverId,
    desired,
    sink,
    signal,
    seams,
  });

  // Payload-free feature-usage capture.
  seams?.captureOpen?.({ serverId, era, supportsListen, transport: "http" });

  try {
    const info = await done;
    seams?.recordClosed?.(info);
    return info;
  } finally {
    await manager.disconnectAllServers().catch(() => {});
    sink.close();
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Defeat proxy buffering so notifications are flushed promptly.
  "X-Accel-Buffering": "no",
};

/** Comment-frame keepalive so an idle proxy/LB can't tear the stream down. */
const SUBSCRIPTION_KEEPALIVE_MS = 25_000;

const subscriptions = new Hono();

subscriptions.post("/listen", async (c) => {
  const actorKey = resolveSubscriptionActorKey(c as never);
  if (!acquireSubscriptionStreamSlot(actorKey)) {
    return webError(
      c,
      429,
      ErrorCode.RATE_LIMITED,
      `Too many concurrent subscription streams (limit ${MAX_CONCURRENT_SUBSCRIPTION_STREAMS}). Close one before opening another.`,
    );
  }

  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSubscriptionStreamSlot(actorKey);
  };

  let manager:
    | Pick<MCPClientManager, "getManagedClient" | "disconnectAllServers">
    | undefined;
  try {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    const conn = await createManualHostedConnection(
      c,
      rawBody,
      hostedSubscriptionSchema,
      { timeoutMs: WEB_CALL_TIMEOUT_MS },
    );
    manager = conn.manager;
    const body = conn.body as z.infer<typeof hostedSubscriptionSchema>;
    const serverId = body.serverId;
    const desired: DesiredSubscriptionInterests = body.desired ?? {};

    // Connect must have produced a live client, or there is nothing to stream.
    if (!manager.getManagedClient(serverId)) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Server "${serverId}" is not connected`,
      );
    }

    const boundManager = manager;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const enqueue = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        const keepAlive = setInterval(() => {
          enqueue(`: keep-alive\n\n`);
        }, SUBSCRIPTION_KEEPALIVE_MS);
        const closeController = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {}
        };

        const sink: SubscriptionSink = {
          send: (event) => enqueue(`data: ${JSON.stringify(event)}\n\n`),
          close: closeController,
        };

        // Advise the browser's reconnect cadence (re-listen, no replay).
        enqueue(`retry: 1500\n\n`);

        void runHostedSubscriptionSession({
          manager: boundManager,
          serverId,
          desired,
          sink,
          signal: c.req.raw.signal,
          seams: {
            captureOpen: (info) => {
              captureServerEvent(c, "subscription_stream_opened_server", {
                era: info.era,
                transport: info.transport,
                supports_listen: info.supportsListen,
              });
            },
            recordClosed: (info) => recordSubscriptionClosed(c, info),
          },
        })
          .catch((error) => {
            logger.error("[subscriptions.hosted] session failed", error, {
              serverId,
            });
          })
          .finally(() => {
            releaseSlot();
            closeController();
          });
      },
      cancel() {
        // The consumer went away without an abort signal firing (rare); the
        // session's own abort/finally still disposes the manager and releases
        // the slot, so nothing to do beyond letting it settle.
      },
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  } catch (error) {
    // Failure BEFORE the Response is returned (authz mismatch, validation, not
    // connected): dispose anything we opened, release the slot, map to HTTP.
    if (manager) {
      await manager.disconnectAllServers().catch(() => {});
    }
    releaseSlot();
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
    );
  }
});

/**
 * Stream duration + close reason to Axiom. Guarded on the request log context so
 * a misconfigured mount degrades to a warning instead of throwing inside the
 * stream lifecycle. NEVER carries a notification payload.
 */
function recordSubscriptionClosed(
  c: {
    var?: { requestLogContext?: RequestLogContext };
  },
  info: HostedSubscriptionTerminalInfo,
): void {
  if (!c.var?.requestLogContext) return;
  try {
    getRequestLogger(c as never, "routes.web.subscriptions").event(
      "subscription.stream.closed",
      {
        era: info.era,
        closeReason: info.reason,
        durationMs: info.durationMs,
        notificationCount: info.notificationCount,
        reconnectAttempt: info.reconnectAttempt,
      },
    );
  } catch (error) {
    logger.warn("[subscriptions.hosted] failed to record stream close", {
      error,
    });
  }
}

export default subscriptions;
