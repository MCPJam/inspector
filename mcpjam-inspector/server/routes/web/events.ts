/**
 * Hosted MCP Events routes (`/api/web/events/*`, bearer auth).
 *
 * The hosted registry (subscriptions, triggers, runs) lives in Convex and the
 * client calls it directly; these routes cover what needs the inspector:
 *
 *   POST list          projectServerSchema + {cursor?} → EventsListResponse
 *                      (200 with `events: []` and `support.declared: false`
 *                      when the server did not declare events — the tab
 *                      renders the raw capabilities in that state)
 *   POST poll          projectServerSchema + poll params → EventsPollResponse
 *   POST viewer-token  {projectId} → EventsViewerTokenResponse
 *   POST simulate      {projectId, subscriptionId, event} → {accepted, eventId}
 *   POST slot-state    {projectId, subscriptionId} → EventsSlotStateResponse
 *
 * `list` / `poll` dial the caller's server through `withEphemeralConnection`
 * (authorize → connect → request → disconnect), exactly like tasks.
 *
 * The other three talk to the inbox Worker with the ADMIN token, so each
 * first proves the caller is a member of the project NOW (C7), through a
 * Convex read made with the caller's own bearer — the inspector never takes
 * a project id's word for it. `simulate` and `slot-state` additionally check
 * that the subscription belongs to that project. A viewer token is the only
 * credential that ever leaves here, and it is scoped to one inbox, read-only,
 * and valid for at most ten minutes.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type {
  EventsListResponse,
  EventsPollResponse,
  EventsSlotStateResponse,
  EventsSupportView,
  EventsViewerTokenResponse,
} from "@/shared/events-api";
import type { MCPClientManager } from "@mcpjam/sdk";
import { InboxBackpressureError } from "@mcpjam/sdk/events";
import {
  handleRoute,
  projectServerSchema,
  readJsonBody,
  parseWithSchema,
  withEphemeralConnection,
} from "./auth.js";
import { ErrorCode, WebRouteError } from "./errors.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  EventsBackendClient,
  isEventsBackendConfigured,
  type EventSubscriptionRow,
} from "../../services/events/backend-client.js";
import { getEventsInboxUrl, getEventsInboxViewerKey } from "../../services/events/config.js";
import { HttpInboxClient } from "../../services/events/inbox-client.js";
import { classifyEventsRouteError } from "../../services/events/route-errors.js";
import { issueViewerToken } from "../../services/events/viewer-token.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { translateConvexReadError } from "../v1/convex-read-errors.js";

// ---------------------------------------------------------------------------
// Seams (tests replace these)
// ---------------------------------------------------------------------------

export interface WebEventsDeps {
  backend: () => Pick<EventsBackendClient, "ensureInbox" | "getSubscription">;
  inbox: (inboxId: string) => Pick<HttpInboxClient, "getViewerEpoch" | "simulate" | "slotState">;
  /** `projects:getProjectCapabilities` with the caller's bearer. */
  projectAccess: (c: Context, projectId: string) => Promise<ProjectAccessRow | null>;
  now: () => number;
}

interface ProjectAccessRow {
  projectId?: string;
  role?: string;
  projectRole?: string | null;
  isProjectAdmin?: boolean;
}

const defaultDeps: WebEventsDeps = {
  backend: () => new EventsBackendClient(),
  inbox: (inboxId) => new HttpInboxClient({ inboxId }),
  projectAccess: async (c, projectId) => {
    const client = createConvexClient(await getConvexBearerForRequest(c));
    try {
      return (await client.query(
        "projects:getProjectCapabilities" as never,
        { projectId } as never,
      )) as ProjectAccessRow | null;
    } catch (error) {
      throw translateConvexReadError(error, {
        scope: "web.events.membership",
        notFoundMessage: "Project not found",
        redactedIsRefusal: true,
      });
    }
  },
  now: () => Date.now(),
};

let deps: WebEventsDeps = defaultDeps;

/** Test seam. Pass `undefined` to restore the defaults. */
export function setWebEventsDepsForTests(next: Partial<WebEventsDeps> | undefined): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ROLE_RANK: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * C7 "member now": an organization member (or higher), or a holder of a
 * project grant. A guest with no grant is refused, as is a caller the read
 * does not recognize at all.
 */
async function assertProjectMember(c: Context, projectId: string): Promise<void> {
  const row = await deps.projectAccess(c, projectId);
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found");
  }
  const rank = ORG_ROLE_RANK[row.role ?? ""] ?? 0;
  const granted =
    row.isProjectAdmin === true || row.projectRole === "admin" || row.projectRole === "editor";
  if (rank < ORG_ROLE_RANK.member! && !granted) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Only project members can read this project's events.",
    );
  }
}

function requireEventsPlane(): void {
  if (!isEventsBackendConfigured()) {
    throw new WebRouteError(
      503,
      ErrorCode.EVENTS_UNAVAILABLE,
      "MCP Events are not configured on this deployment.",
    );
  }
}

/** The subscription, verified to belong to `projectId` (else 404 — no oracle). */
async function projectSubscription(
  projectId: string,
  subscriptionId: string,
): Promise<EventSubscriptionRow> {
  const row = await deps.backend().getSubscription(subscriptionId);
  if (!row || String(row.projectId) !== projectId) {
    throw new WebRouteError(404, ErrorCode.EVENTS_NOT_FOUND, "Subscription not found");
  }
  return row;
}

function decodeJwtSub(bearer: string): string | undefined {
  const parts = bearer.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who the viewer token is for (the inbox keys consumer checkpoints on it).
 * Always a VERIFIED identity: the gateway's, or — once the membership read
 * above has accepted the bearer — the bearer's own subject.
 */
async function viewerUserId(c: Context): Promise<string> {
  const known =
    (c.get("mcpjamUserId") as string | undefined) ??
    (c.get("workosUserId") as string | undefined);
  if (known) return known;
  const guestId = c.get("guestId") as string | undefined;
  if (guestId) return `guest:${guestId}`;
  const sub = decodeJwtSub(await getConvexBearerForRequest(c));
  if (sub) return sub;
  throw new WebRouteError(401, ErrorCode.UNAUTHORIZED, "Cannot identify the viewer.");
}

function supportView(manager: MCPClientManager, serverId: string): {
  support: EventsSupportView;
  rawCapabilities?: Record<string, unknown>;
  protocolVersion?: string;
} {
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

/** The inbox's 503 → our 503 with its `Retry-After`. */
async function withInboxBackpressure<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InboxBackpressureError) {
      throw new WebRouteError(
        503,
        ErrorCode.EVENTS_UNAVAILABLE,
        "The project's event inbox is full; retry shortly.",
      ).withHeaders({
        "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
      });
    }
    throw error;
  }
}

/** Events failures → the events codes; anything else passes through. */
async function mapEventsErrors<T>(method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const classified = classifyEventsRouteError(method, error);
    if (classified) {
      throw new WebRouteError(
        classified.status,
        ErrorCode[classified.code],
        classified.message,
        classified.details,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const eventsListSchema = projectServerSchema.extend({
  cursor: z.string().optional(),
});

const eventsPollSchema = projectServerSchema.extend({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  cursor: z.string().nullable().default(null),
  maxAgeMs: z.number().int().positive().optional(),
  maxEvents: z.number().int().positive().optional(),
});

const viewerTokenSchema = z.object({ projectId: z.string().min(1) });

const simulateSchema = z.object({
  projectId: z.string().min(1),
  subscriptionId: z.string().min(1),
  event: z.object({
    eventId: z.string().min(1).max(512).optional(),
    name: z.string().min(1).optional(),
    timestamp: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  }),
});

const slotStateSchema = z.object({
  projectId: z.string().min(1),
  subscriptionId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const events = new Hono();

events.post("/list", async (c) =>
  withEphemeralConnection(c, eventsListSchema, async (manager, body) =>
    mapEventsErrors("events/list", async () => {
      const support = await manager.ensureEventsSupport(body.serverId);
      if (!support.declared) {
        // Nothing is sent to a server that did not declare events; the tab
        // still shows what the handshake DID carry.
        const undeclared: EventsListResponse = {
          events: [],
          ...supportView(manager, body.serverId),
        };
        return undeclared;
      }
      const result = await manager.listServerEvents(
        body.serverId,
        body.cursor ? { cursor: body.cursor } : undefined,
      );
      const response: EventsListResponse = {
        events: result.events as EventsListResponse["events"],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        ...supportView(manager, body.serverId),
      };
      return response;
    }),
  ),
);

events.post("/poll", async (c) =>
  withEphemeralConnection(c, eventsPollSchema, async (manager, body) =>
    mapEventsErrors("events/poll", async () => {
      await manager.ensureEventsSupport(body.serverId);
      const result = await manager.pollServerEvents(body.serverId, {
        name: body.name,
        arguments: body.arguments,
        cursor: body.cursor,
        ...(body.maxAgeMs !== undefined ? { maxAgeMs: body.maxAgeMs } : {}),
        ...(body.maxEvents !== undefined ? { maxEvents: body.maxEvents } : {}),
      });
      const response: EventsPollResponse = {
        events: result.events as EventsPollResponse["events"],
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
        ...(result.nextPollMs !== undefined ? { nextPollMs: result.nextPollMs } : {}),
      };
      return response;
    }),
  ),
);

events.post("/viewer-token", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(viewerTokenSchema, await readJsonBody(c));
    requireEventsPlane();
    if (!getEventsInboxViewerKey()) {
      throw new WebRouteError(
        503,
        ErrorCode.EVENTS_UNAVAILABLE,
        "The events feed is not configured on this deployment.",
      );
    }
    await assertProjectMember(c, body.projectId);
    const userId = await viewerUserId(c);
    const { inboxId } = await deps.backend().ensureInbox(body.projectId);
    // The token must carry the inbox's CURRENT epoch; a bumped epoch revokes
    // every older token, so it is read, never assumed.
    const epoch = await deps.inbox(inboxId).getViewerEpoch();
    const issued = issueViewerToken({
      inboxId,
      projectId: body.projectId,
      userId,
      epoch,
      nowMs: deps.now(),
    });
    const origin = getEventsInboxUrl();
    const response: EventsViewerTokenResponse = {
      inboxId,
      token: issued.token,
      expiresAt: issued.expiresAt,
      feedUrl: `${origin}/i/${inboxId}/deliveries`,
      streamUrl: `${origin}/i/${inboxId}/stream`,
    };
    c.header("Cache-Control", "no-store");
    return response;
  }),
);

events.post("/simulate", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(simulateSchema, await readJsonBody(c));
    requireEventsPlane();
    await assertProjectMember(c, body.projectId);
    const row = await projectSubscription(body.projectId, body.subscriptionId);
    if (row.desiredState === "removed") {
      throw new WebRouteError(
        404,
        ErrorCode.EVENTS_NOT_FOUND,
        "The subscription was removed.",
      );
    }
    const inboxId = row.inboxId ?? (await deps.backend().ensureInbox(body.projectId)).inboxId;
    const eventId = body.event.eventId ?? `sim_${crypto.randomUUID()}`;
    const result = await withInboxBackpressure(() => deps.inbox(inboxId).simulate({
      logicalSubscriptionId: row.logicalId,
      projectId: body.projectId,
      environmentId: row.environmentId ? String(row.environmentId) : null,
      bindingKey: row.bindingKey,
      event: {
        eventId,
        name: body.event.name ?? row.eventName,
        timestamp: body.event.timestamp ?? new Date(deps.now()).toISOString(),
        data: body.event.data,
      },
    }));
    return {
      accepted: result.accepted > 0 || result.duplicates > 0,
      eventId,
      ...(result.duplicates > 0 ? { duplicate: true } : {}),
    };
  }),
);

events.post("/slot-state", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(slotStateSchema, await readJsonBody(c));
    requireEventsPlane();
    await assertProjectMember(c, body.projectId);
    const row = await projectSubscription(body.projectId, body.subscriptionId);
    if (!row.inboxId || !row.slotId) {
      throw new WebRouteError(
        404,
        ErrorCode.EVENTS_NOT_FOUND,
        "This subscription has no receiver slot (it is not a webhook subscription, or it has not registered yet).",
      );
    }
    const state = await deps.inbox(row.inboxId).slotState(row.slotId);
    const response: EventsSlotStateResponse = {
      state: String(state.state),
      ...(typeof state.serverSubscriptionId === "string"
        ? { serverSubscriptionId: state.serverSubscriptionId }
        : {}),
      ...(Array.isArray(state.observedSubscriptionIds)
        ? { observedSubscriptionIds: state.observedSubscriptionIds }
        : {}),
      ...(state.counts ? { counts: state.counts } : {}),
      rejections: (state.rejections ?? []).map((rejection) => ({
        reason: rejection.reason,
        ...(rejection.slotId ? { slotId: rejection.slotId } : {}),
        at: rejection.at,
        headerNames: Array.isArray(rejection.headerNames) ? rejection.headerNames : [],
        bodyBytes: rejection.bodyBytes,
      })),
    };
    return response;
  }),
);

export default events;
