/**
 * LOCAL MCP Events routes (`/api/mcp/events/*`; mounted only when not hosted).
 *
 * Server operations (`support`, `list`, `poll`) drive the singleton
 * `MCPClientManager`; subscriptions, the feed and the development webhook
 * receiver drive the {@link LocalEventsRuntime} bound to that manager.
 *
 *   POST support                     {serverId} → {support, rawCapabilities?, protocolVersion?}
 *   POST list                        {serverId, cursor?} → EventsListResponse
 *                                    (200, `events: []`, `support.declared:
 *                                    false` for a server without events)
 *   POST poll                        EventsPollRequest → EventsPollResponse (one-off)
 *   GET  subscriptions?serverId=     → {subscriptions}
 *   POST subscriptions               EventsCreateSubscriptionRequest → {subscription}
 *   POST subscriptions/:id/state     {desiredState} → {subscription}
 *   POST subscriptions/:id/rotate    → {subscription}
 *   POST simulate                    EventsSimulateRequest → {entry}
 *   GET  feed?after=&limit=          → {entries, nextAfter}
 *   GET  stream?after=               SSE of EventsStreamFrame
 *   POST hooks/i/:inboxId/s/:slotId  the development receiver (no session;
 *                                    Standard-Webhooks signature-verified on
 *                                    the RAW body; `insecure-local-receiver`)
 *
 * Errors answer `{code, message}` with the `EventsRouteErrorCode` set.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { MCPClientManager } from "@mcpjam/sdk";
import { isEventsProfileId } from "@mcpjam/sdk/events";
import type {
  EventsCreateSubscriptionRequest,
  EventsListResponse,
  EventsPollResponse,
  EventsSupportView,
} from "@/shared/events-api";
import "../../types/hono";
import { SERVER_PORT } from "../../config.js";
import {
  LocalEventsError,
  LocalEventsRuntime,
} from "../../services/events/local-runtime.js";
import { classifyEventsRouteError } from "../../services/events/route-errors.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

/** Receiver bodies are capped by the inbox too; refuse obvious floods early. */
const MAX_HOOK_BODY_BYTES = 262_144 + 1;

export interface LocalEventsRouterOptions {
  /** Callback URL origin. Default `http://127.0.0.1:<SERVER_PORT>/api/mcp/events/hooks`. */
  publicOrigin?: () => string;
  /** Runtime knobs (tests). */
  runtimeOptions?: Partial<
    Omit<ConstructorParameters<typeof LocalEventsRuntime>[0], "manager" | "publicOrigin">
  >;
}

function toSupportView(
  manager: MCPClientManager,
  serverId: string,
): { support: EventsSupportView; rawCapabilities?: Record<string, unknown>; protocolVersion?: string } {
  const support = manager.getEventsSupport(serverId);
  const captured = manager.getCapturedEventsCapability(serverId);
  return {
    support: {
      handshakeObserved: support.handshakeObserved,
      declared: support.declared,
      listChanged: support.listChanged,
      ...(support.capability ? { capability: support.capability } : {}),
      ...(support.source ? { source: support.source } : {}),
    },
    ...(captured?.rawCapabilities ? { rawCapabilities: captured.rawCapabilities } : {}),
    ...(captured?.protocolVersion ? { protocolVersion: captured.protocolVersion } : {}),
  };
}

/** The request body, or `null` once it exceeds `maxBytes`. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function eventsError(
  c: Context,
  status: 400 | 404 | 500 | 502,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json({ code, message, ...(details ? { details } : {}) }, status);
}

/** One failure → one response: events classes first, then "unknown server". */
function respondWithError(c: Context, method: string, error: unknown, source: string) {
  if (error instanceof LocalEventsError) {
    return eventsError(c, error.status, error.code, error.message);
  }
  const classified = classifyEventsRouteError(method, error);
  if (classified) {
    return eventsError(c, classified.status, classified.code, classified.message, classified.details);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown (mcp )?server|not connected|no server|is not registered/i.test(message)) {
    return eventsError(c, 404, "EVENTS_NOT_FOUND", message);
  }
  reportRouteFailure("MCP events route failed", error, {
    source,
    hop: "user_server_hop",
  });
  return eventsError(c, 500, "EVENTS_UNAVAILABLE", message);
}

export function createLocalEventsRouter(options: LocalEventsRouterOptions = {}): Hono {
  const router = new Hono();
  const runtimes = new WeakMap<MCPClientManager, LocalEventsRuntime>();
  const publicOrigin =
    options.publicOrigin ?? (() => `http://127.0.0.1:${SERVER_PORT}/api/mcp/events/hooks`);

  const runtimeFor = (manager: MCPClientManager): LocalEventsRuntime => {
    let runtime = runtimes.get(manager);
    if (!runtime) {
      runtime = new LocalEventsRuntime({
        ...(options.runtimeOptions ?? {}),
        manager,
        publicOrigin: publicOrigin(),
      });
      runtimes.set(manager, runtime);
    }
    return runtime;
  };

  // --- Server operations ------------------------------------------------------

  router.post("/support", async (c) => {
    const body = await readBody(c);
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    if (!serverId) return eventsError(c, 400, "EVENTS_NOT_FOUND", "serverId is required");
    try {
      await c.mcpClientManager.ensureEventsSupport(serverId);
      return c.json(toSupportView(c.mcpClientManager, serverId));
    } catch (error) {
      return respondWithError(c, "events/list", error, "mcp.events.support");
    }
  });

  router.post("/list", async (c) => {
    const body = await readBody(c);
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    if (!serverId) return eventsError(c, 400, "EVENTS_NOT_FOUND", "serverId is required");
    const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
    const manager = c.mcpClientManager;
    try {
      const support = await manager.ensureEventsSupport(serverId);
      if (!support.declared) {
        // Undeclared is an answer, not an error: nothing is sent to the
        // server, and the tab shows the raw capabilities it DID declare.
        const undeclared: EventsListResponse = {
          events: [],
          ...toSupportView(manager, serverId),
        };
        return c.json(undeclared);
      }
      const result = await manager.listServerEvents(serverId, cursor ? { cursor } : undefined);
      const response: EventsListResponse = {
        events: result.events as EventsListResponse["events"],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        ...toSupportView(manager, serverId),
      };
      return c.json(response);
    } catch (error) {
      return respondWithError(c, "events/list", error, "mcp.events.list");
    }
  });

  router.post("/poll", async (c) => {
    const body = await readBody(c);
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    const name = typeof body.name === "string" ? body.name : "";
    if (!serverId || !name) {
      return eventsError(c, 400, "EVENTS_NOT_FOUND", "serverId and name are required");
    }
    const manager = c.mcpClientManager;
    try {
      await manager.ensureEventsSupport(serverId);
      const result = await manager.pollServerEvents(serverId, {
        name,
        arguments: isRecord(body.arguments) ? body.arguments : {},
        cursor: typeof body.cursor === "string" ? body.cursor : null,
        ...(typeof body.maxAgeMs === "number" ? { maxAgeMs: body.maxAgeMs } : {}),
        ...(typeof body.maxEvents === "number" ? { maxEvents: body.maxEvents } : {}),
      });
      const response: EventsPollResponse = {
        events: result.events as EventsPollResponse["events"],
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
        ...(result.nextPollMs !== undefined ? { nextPollMs: result.nextPollMs } : {}),
      };
      return c.json(response);
    } catch (error) {
      return respondWithError(c, "events/poll", error, "mcp.events.poll");
    }
  });

  // --- Subscriptions -------------------------------------------------------------

  router.get("/subscriptions", (c) => {
    const serverId = c.req.query("serverId") || undefined;
    return c.json({ subscriptions: runtimeFor(c.mcpClientManager).list(serverId) });
  });

  router.post("/subscriptions", async (c) => {
    const body = await readBody(c);
    const mode = body.mode;
    if (
      typeof body.serverId !== "string" ||
      !body.serverId ||
      typeof body.eventName !== "string" ||
      !body.eventName ||
      (mode !== "poll" && mode !== "push" && mode !== "webhook") ||
      !isEventsProfileId(body.profile)
    ) {
      return eventsError(
        c,
        400,
        "EVENTS_UNAVAILABLE",
        "serverId, eventName, mode (poll|push|webhook) and a known profile are required",
      );
    }
    const request: EventsCreateSubscriptionRequest = {
      serverId: body.serverId,
      eventName: body.eventName,
      arguments: isRecord(body.arguments) ? body.arguments : {},
      mode,
      profile: body.profile,
      ...(typeof body.maxAgeMs === "number" ? { maxAgeMs: body.maxAgeMs } : {}),
      ...(typeof body.ttlMs === "number" || body.ttlMs === null
        ? { ttlMs: body.ttlMs as number | null }
        : {}),
      ...(Array.isArray(body.overrides)
        ? { overrides: body.overrides.filter((value): value is "insecure-local-receiver" => value === "insecure-local-receiver") }
        : {}),
    };
    const manager = c.mcpClientManager;
    try {
      // Advertise = enforce: a server that did not declare events gets no
      // subscription at all, rather than one that fails on its first step.
      const support = await manager.ensureEventsSupport(request.serverId);
      if (!support.declared) {
        return eventsError(
          c,
          400,
          "EVENTS_UNDECLARED",
          support.handshakeObserved
            ? `"${request.serverId}" did not declare capabilities.events.`
            : `The handshake with "${request.serverId}" was not observed, so its events capability is unknown.`,
          { handshakeObserved: support.handshakeObserved },
        );
      }
      const subscription = runtimeFor(manager).create(request);
      return c.json({ subscription });
    } catch (error) {
      return respondWithError(c, "events/subscribe", error, "mcp.events.subscriptions.create");
    }
  });

  router.post("/subscriptions/:id/state", async (c) => {
    const body = await readBody(c);
    const desiredState = body.desiredState;
    if (desiredState !== "active" && desiredState !== "paused" && desiredState !== "removed") {
      return eventsError(c, 400, "EVENTS_UNAVAILABLE", "desiredState must be active, paused or removed");
    }
    try {
      const subscription = runtimeFor(c.mcpClientManager).setDesiredState(
        c.req.param("id"),
        desiredState,
      );
      return c.json({ subscription });
    } catch (error) {
      return respondWithError(c, "events/subscribe", error, "mcp.events.subscriptions.state");
    }
  });

  router.post("/subscriptions/:id/rotate", async (c) => {
    try {
      const subscription = runtimeFor(c.mcpClientManager).rotate(c.req.param("id"));
      return c.json({ subscription });
    } catch (error) {
      return respondWithError(c, "events/subscribe", error, "mcp.events.subscriptions.rotate");
    }
  });

  // --- Feed ----------------------------------------------------------------------

  router.post("/simulate", async (c) => {
    const body = await readBody(c);
    const event = isRecord(body.event) ? body.event : undefined;
    if (typeof body.subscriptionId !== "string" || !event || !isRecord(event.data)) {
      return eventsError(
        c,
        400,
        "EVENTS_UNAVAILABLE",
        "subscriptionId and event.data (an object) are required",
      );
    }
    try {
      const entry = await runtimeFor(c.mcpClientManager).simulate({
        subscriptionId: body.subscriptionId,
        event: {
          ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
          ...(typeof event.name === "string" ? { name: event.name } : {}),
          ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
          data: event.data,
        },
      });
      return c.json({ entry });
    } catch (error) {
      return respondWithError(c, "events/poll", error, "mcp.events.simulate");
    }
  });

  router.get("/feed", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 200);
    return c.json(
      runtimeFor(c.mcpClientManager).feed(
        Number.isFinite(after) && after > 0 ? Math.floor(after) : 0,
        Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200,
      ),
    );
  });

  router.get("/stream", (c) => {
    const afterParam = Number(c.req.query("after") ?? 0);
    const after = Number.isFinite(afterParam) && afterParam > 0 ? Math.floor(afterParam) : 0;
    const runtime = runtimeFor(c.mcpClientManager);
    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (frame: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          } catch {
            close();
          }
        };
        const keepAlive = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            close();
          }
        }, 25_000);
        const opened = runtime.openStream(after, send);
        function close() {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          opened.close();
          try {
            controller.close();
          } catch {}
        }
        cleanup = close;
        controller.enqueue(encoder.encode(`retry: 1500\n\n`));
        send(opened.snapshot);
        for (const entry of opened.backlog) send({ type: "entry", entry });
        c.req.raw.signal?.addEventListener?.("abort", close);
      },
      cancel() {
        cleanup?.();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // --- The development receiver ----------------------------------------------------

  router.post("/hooks/i/:inboxId/s/:slotId", async (c) => {
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_HOOK_BODY_BYTES) {
      return c.json({ error: "body_too_large" }, 413);
    }
    // The RAW bytes, before anything parses them: the signature covers
    // exactly what was sent. Read with a ceiling, so a chunked body that lies
    // about (or omits) its length cannot make this process buffer it all.
    const body = await readBoundedBody(c.req.raw, MAX_HOOK_BODY_BYTES);
    if (!body) return c.json({ error: "body_too_large" }, 413);
    const result = await runtimeFor(c.mcpClientManager).receive({
      inboxId: c.req.param("inboxId"),
      slotId: c.req.param("slotId"),
      headers: c.req.raw.headers,
      body,
    });
    return c.json((result.body ?? {}) as Record<string, unknown>, result.status as 200, {
      ...(result.headers ?? {}),
    });
  });

  return router;
}

const events = createLocalEventsRouter();

export default events;
