/**
 * MCP Events (draft extension) API client for the Events tab.
 *
 * Two data planes, chosen per call with `runByMode`:
 *
 *   - LOCAL (`/api/mcp/events/*`): the local inspector's singleton manager
 *     and its in-memory events runtime. The registry, the inbox and the feed
 *     all live in the local server; the feed is an SSE stream of
 *     `EventsStreamFrame`s.
 *   - HOSTED (`/api/web/events/*`): server operations run over an ephemeral
 *     connection; the registry is Convex, which the tab reads and writes
 *     directly (`EVENT_SUBSCRIPTIONS_API` below, used through
 *     `useQuery`/`useMutation`); the feed is the public inbox, read with a
 *     short-lived viewer token (contract C7).
 *
 * Nothing that crosses this module carries a webhook secret. The viewer token
 * is the one credential, and it only ever goes to the inbox's feed URLs.
 */
import { makeFunctionReference } from "convex/server";
import { authFetch, addTokenToUrl } from "@/lib/session-token";
import { runByMode } from "@/lib/apis/mode-client";
import { webPost, WebApiError } from "@/lib/apis/web/base";
import {
  buildServerRequest,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";
import type {
  EventDescriptorView,
  EventsCreateSubscriptionRequest,
  EventsDeliveryModeView,
  EventsFeedEntryView,
  EventsListResponse,
  EventsObservedStateView,
  EventsProfileIdView,
  EventsRejectionView,
  EventsSimulateRequest,
  EventsSlotStateResponse,
  EventsSubscriptionView,
  EventsSupportView,
  EventsViewerTokenResponse,
} from "@/shared/events-api";

// ── errors ─────────────────────────────────────────────────────────────────

/** A failed events route, keeping the route's stable `code` when it sent one. */
export class EventsApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EventsApiError";
  }
}

export function eventsErrorCode(error: unknown): string | undefined {
  if (error instanceof EventsApiError) return error.code;
  if (error instanceof WebApiError) return error.code ?? undefined;
  return undefined;
}

export function isEventsUndeclaredError(error: unknown): boolean {
  return eventsErrorCode(error) === "EVENTS_UNDECLARED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function routeError(
  response: Response,
  body: unknown,
  fallback: string,
): EventsApiError {
  const record = isRecord(body) ? body : {};
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.error === "string" && /^[a-z_]+$/i.test(record.error)
        ? record.error
        : undefined;
  const message =
    (typeof record.message === "string" && record.message.trim()) ||
    (typeof record.error === "string" && record.error.trim()) ||
    `${fallback} (${response.status})`;
  return new EventsApiError(message, code, response.status);
}

/** A local `/api/mcp/events/*` call that keeps the route's error code. */
async function localEventsRequest<T>(
  path: string,
  init: { method: "GET" } | { method: "POST"; body?: unknown },
  fallback: string,
): Promise<T> {
  const response = await authFetch(
    path,
    init.method === "GET"
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(init.body ?? {}),
        },
  );
  const body = await readJson(response);
  if (!response.ok) throw routeError(response, body, fallback);
  return body as T;
}

// ── catalog: support + event types ─────────────────────────────────────────

const UNDECLARED_SUPPORT: EventsSupportView = {
  handshakeObserved: true,
  declared: false,
  listChanged: false,
};

/**
 * The server's events support and its event types, in one shape for both
 * modes. An undeclared server is a normal answer (`events: []`,
 * `support.declared: false`), never an error: the tab shows it as an empty
 * state, not a failure.
 */
export async function loadEventsCatalog(
  serverName: string,
  cursor?: string,
): Promise<EventsListResponse> {
  return runByMode({
    hosted: async () => {
      try {
        return await webPost<Record<string, unknown>, EventsListResponse>(
          "/api/web/events/list",
          {
            ...buildServerRequest(serverName),
            ...(cursor !== undefined ? { cursor } : {}),
          },
        );
      } catch (error) {
        if (isEventsUndeclaredError(error)) {
          return { events: [], support: UNDECLARED_SUPPORT };
        }
        throw error;
      }
    },
    local: async () => {
      const probe = await localEventsRequest<{
        support: EventsSupportView;
        rawCapabilities?: Record<string, unknown>;
        protocolVersion?: string;
      }>(
        "/api/mcp/events/support",
        { method: "POST", body: { serverId: serverName } },
        "Events support check failed",
      );
      const undeclared: EventsListResponse = {
        events: [],
        support: probe.support,
        ...(probe.rawCapabilities
          ? { rawCapabilities: probe.rawCapabilities }
          : {}),
        ...(probe.protocolVersion
          ? { protocolVersion: probe.protocolVersion }
          : {}),
      };
      if (!probe.support?.declared) return undeclared;
      try {
        const list = await localEventsRequest<EventsListResponse>(
          "/api/mcp/events/list",
          {
            method: "POST",
            body: {
              serverId: serverName,
              ...(cursor !== undefined ? { cursor } : {}),
            },
          },
          "Listing events failed",
        );
        return {
          ...list,
          rawCapabilities: list.rawCapabilities ?? probe.rawCapabilities,
          protocolVersion: list.protocolVersion ?? probe.protocolVersion,
        };
      } catch (error) {
        if (isEventsUndeclaredError(error)) return undeclared;
        throw error;
      }
    },
  });
}

// ── local registry ─────────────────────────────────────────────────────────

export async function listLocalEventSubscriptions(
  serverName: string,
): Promise<EventsSubscriptionView[]> {
  const body = await localEventsRequest<{
    subscriptions: EventsSubscriptionView[];
  }>(
    `/api/mcp/events/subscriptions?serverId=${encodeURIComponent(serverName)}`,
    { method: "GET" },
    "Listing subscriptions failed",
  );
  return body.subscriptions ?? [];
}

export async function createLocalEventSubscription(
  request: EventsCreateSubscriptionRequest,
): Promise<EventsSubscriptionView> {
  const body = await localEventsRequest<{
    subscription: EventsSubscriptionView;
  }>(
    "/api/mcp/events/subscriptions",
    { method: "POST", body: request },
    "Subscribing failed",
  );
  return body.subscription;
}

export async function setLocalEventSubscriptionState(
  subscriptionId: string,
  desiredState: EventsSubscriptionView["desiredState"],
): Promise<EventsSubscriptionView> {
  const body = await localEventsRequest<{
    subscription: EventsSubscriptionView;
  }>(
    `/api/mcp/events/subscriptions/${encodeURIComponent(subscriptionId)}/state`,
    { method: "POST", body: { desiredState } },
    "Updating the subscription failed",
  );
  return body.subscription;
}

export async function rotateLocalEventSubscriptionSecret(
  subscriptionId: string,
): Promise<EventsSubscriptionView> {
  const body = await localEventsRequest<{
    subscription: EventsSubscriptionView;
  }>(
    `/api/mcp/events/subscriptions/${encodeURIComponent(subscriptionId)}/rotate`,
    { method: "POST" },
    "Rotating the secret failed",
  );
  return body.subscription;
}

// ── simulation ─────────────────────────────────────────────────────────────

/**
 * Send a simulated event (namespace `simulation`, contract C2: it can never
 * collide with or suppress a live run). Locally the journalled entry comes
 * back; hosted, the inbox accepts it and it arrives through the feed.
 */
export async function simulateEvent(options: {
  projectId: string | null;
  request: EventsSimulateRequest;
}): Promise<{ entry?: EventsFeedEntryView; accepted?: boolean }> {
  return runByMode<{ entry?: EventsFeedEntryView; accepted?: boolean }>({
    hosted: async () => {
      if (!options.projectId) {
        throw new EventsApiError("No project is selected.");
      }
      return webPost<Record<string, unknown>, { accepted?: boolean }>(
        "/api/web/events/simulate",
        { projectId: options.projectId, ...options.request },
      );
    },
    local: async () => {
      const body = await localEventsRequest<{ entry?: unknown }>(
        "/api/mcp/events/simulate",
        { method: "POST", body: options.request },
        "Simulating the event failed",
      );
      const entry = normalizeFeedEntry(body.entry);
      return entry ? { entry } : {};
    },
  });
}

// ── feed ───────────────────────────────────────────────────────────────────

/**
 * One feed entry, whichever producer sent it. The hosted inbox names the
 * dispatch state `dispatchState` and may send `slotId: null`; the local
 * runtime already speaks `EventsFeedEntryView`. Returns null for anything
 * that is not an entry (no numeric `seq`).
 */
export function normalizeFeedEntry(raw: unknown): EventsFeedEntryView | null {
  if (!isRecord(raw) || typeof raw.seq !== "number") return null;
  const { dispatchState, dispatch, slotId, ...rest } = raw;
  const dispatchValue =
    typeof dispatch === "string"
      ? dispatch
      : typeof dispatchState === "string"
        ? dispatchState
        : undefined;
  return {
    ...rest,
    seq: raw.seq,
    kind: typeof raw.kind === "string" ? raw.kind : "event",
    origin: (typeof raw.origin === "string"
      ? raw.origin
      : "webhook") as EventsFeedEntryView["origin"],
    namespace: typeof raw.namespace === "string" ? raw.namespace : "live",
    logicalSubscriptionId:
      typeof raw.logicalSubscriptionId === "string"
        ? raw.logicalSubscriptionId
        : "",
    receivedAt:
      typeof raw.receivedAt === "number" ? raw.receivedAt : Date.now(),
    ...(typeof slotId === "string" ? { slotId } : {}),
    ...(dispatchValue !== undefined ? { dispatch: dispatchValue } : {}),
  } as EventsFeedEntryView;
}

export function localEventsStreamUrl(after: number): string {
  return addTokenToUrl(`/api/mcp/events/stream?after=${after}`);
}

export async function fetchLocalEventsFeed(after: number): Promise<{
  entries: EventsFeedEntryView[];
  nextAfter: number;
}> {
  const body = await localEventsRequest<{
    entries?: unknown[];
    nextAfter?: number;
  }>(
    `/api/mcp/events/feed?after=${after}`,
    { method: "GET" },
    "Reading the events feed failed",
  );
  const entries = (body.entries ?? [])
    .map(normalizeFeedEntry)
    .filter((entry): entry is EventsFeedEntryView => entry !== null);
  return { entries, nextAfter: body.nextAfter ?? after };
}

/** POST `/api/web/events/viewer-token`: a ≤ 10 minute feed token (C7). */
export async function fetchEventsViewerToken(
  projectId: string,
): Promise<EventsViewerTokenResponse> {
  return webPost<{ projectId: string }, EventsViewerTokenResponse>(
    "/api/web/events/viewer-token",
    { projectId },
  );
}

function withQuery(base: string, params: Record<string, string>): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(base, origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** SSE URL for the hosted inbox. EventSource cannot set headers, hence `token`. */
export function hostedEventsStreamUrl(
  streamUrl: string,
  after: number,
  token: string,
): string {
  return withQuery(streamUrl, { after: String(after), token });
}

export const HOSTED_FEED_PAGE_LIMIT = 200;

export interface HostedFeedPage {
  entries: EventsFeedEntryView[];
  nextAfter: number;
  gap?: { fromSeq: number; toSeq: number };
}

/**
 * The hosted inbox's JSON backlog (the polling fallback when EventSource is
 * unavailable or keeps failing). A 401 is `code: "unauthorized"`: the token
 * expired or was revoked, and the caller fetches a new one.
 */
export async function fetchHostedEventsFeed(options: {
  feedUrl: string;
  token: string;
  after: number;
  limit?: number;
}): Promise<HostedFeedPage> {
  const response = await fetch(
    withQuery(options.feedUrl, {
      after: String(options.after),
      limit: String(options.limit ?? HOSTED_FEED_PAGE_LIMIT),
    }),
    { headers: { Authorization: `Bearer ${options.token}` } },
  );
  const body = await readJson(response);
  if (!response.ok) {
    if (response.status === 401) {
      throw new EventsApiError(
        (isRecord(body) && typeof body.reason === "string" && body.reason) ||
          "The feed token expired.",
        "unauthorized",
        401,
      );
    }
    throw routeError(response, body, "Reading the events feed failed");
  }
  const record = isRecord(body) ? body : {};
  const entries = (Array.isArray(record.entries) ? record.entries : [])
    .map(normalizeFeedEntry)
    .filter((entry): entry is EventsFeedEntryView => entry !== null);
  const gap = isRecord(record.gap) ? parseGap(record.gap) : undefined;
  return {
    entries,
    nextAfter:
      typeof record.nextAfter === "number" ? record.nextAfter : options.after,
    ...(gap ? { gap } : {}),
  };
}

export function parseGap(
  raw: unknown,
): { fromSeq: number; toSeq: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const { fromSeq, toSeq } = raw;
  if (typeof fromSeq !== "number" || typeof toSeq !== "number") {
    return undefined;
  }
  return { fromSeq, toSeq };
}

/** Hosted: a webhook slot's state and its recent rejected deliveries. */
export async function fetchEventsSlotState(options: {
  projectId: string;
  subscriptionId: string;
}): Promise<EventsSlotStateResponse> {
  return webPost<Record<string, unknown>, EventsSlotStateResponse>(
    "/api/web/events/slot-state",
    { projectId: options.projectId, subscriptionId: options.subscriptionId },
  );
}

export type { EventsRejectionView };

// ── hosted registry (Convex, called from the client) ──────────────────────

/**
 * An `eventSubscriptions` row as `eventSubscriptions:list` returns it
 * (`publicSubscription`: the lease token is stripped).
 */
export interface HostedEventSubscriptionRow {
  _id: string;
  logicalId: string;
  projectId: string;
  environmentId?: string;
  binding?: { serverId: string };
  locality?: "hosted" | "local";
  profile: EventsProfileIdView;
  protocolVersion?: string;
  eventName: string;
  arguments?: Record<string, unknown>;
  mode: EventsDeliveryModeView;
  desiredState: EventsSubscriptionView["desiredState"];
  observedState: EventsObservedStateView;
  generation: number;
  nextActionAt?: number;
  refreshBefore?: number | null;
  lastCursor?: string | null;
  callbackUrl?: string;
  serverSubscriptionId?: string;
  conflictingServerSubscriptionId?: string;
  deliveryStatus?: unknown;
  lastError?: EventsSubscriptionView["lastError"];
  consecutiveFailures?: number;
  lastGapAt?: number;
  rotation?: { phase: "requested" | "rotated"; at: number };
  overrides?: Array<"insecure-local-receiver">;
  createdAt?: number;
}

export interface HostedEventDescriptor {
  hash: string;
  payloadSchema?: Record<string, unknown>;
  delivery: string[];
}

// A type alias, not an interface: Convex function args need an index signature.
export type HostedCreateSubscriptionArgs = {
  projectId: string;
  environmentId?: string;
  serverId: string;
  eventName: string;
  arguments: Record<string, unknown>;
  mode: EventsDeliveryModeView;
  profile: EventsProfileIdView;
  protocolVersion?: string;
  descriptor?: HostedEventDescriptor;
  locality: "hosted";
  maxAgeMs?: number;
  ttlMs?: number | null;
};

export const EVENT_SUBSCRIPTIONS_API = {
  list: makeFunctionReference<
    "query",
    { projectId: string },
    HostedEventSubscriptionRow[]
  >("eventSubscriptions:list"),
  create: makeFunctionReference<
    "mutation",
    HostedCreateSubscriptionArgs,
    HostedEventSubscriptionRow
  >("eventSubscriptions:create"),
  setDesiredState: makeFunctionReference<
    "mutation",
    {
      subscriptionId: string;
      desiredState: EventsSubscriptionView["desiredState"];
    },
    HostedEventSubscriptionRow
  >("eventSubscriptions:setDesiredState"),
  requestRotation: makeFunctionReference<
    "mutation",
    { subscriptionId: string },
    HostedEventSubscriptionRow
  >("eventSubscriptions:requestRotation"),
  reauthorize: makeFunctionReference<
    "mutation",
    { subscriptionId: string },
    HostedEventSubscriptionRow
  >("eventSubscriptions:reauthorize"),
};

/** A Convex registry row, in the tab's one subscription shape. */
export function hostedSubscriptionRowToView(
  row: HostedEventSubscriptionRow,
): EventsSubscriptionView {
  return {
    id: String(row._id),
    logicalId: row.logicalId,
    serverId: row.binding?.serverId ?? "",
    eventName: row.eventName,
    arguments: row.arguments ?? {},
    mode: row.mode,
    profile: row.profile,
    desiredState: row.desiredState,
    observedState: row.observedState,
    generation: row.generation,
    ...(row.nextActionAt !== undefined
      ? { nextActionAt: row.nextActionAt }
      : {}),
    ...(row.refreshBefore !== undefined
      ? { refreshBefore: row.refreshBefore }
      : {}),
    ...(row.lastCursor !== undefined ? { lastCursor: row.lastCursor } : {}),
    ...(row.callbackUrl ? { callbackUrl: row.callbackUrl } : {}),
    ...(row.serverSubscriptionId
      ? { serverSubscriptionId: row.serverSubscriptionId }
      : {}),
    ...(row.conflictingServerSubscriptionId
      ? { conflictingServerSubscriptionId: row.conflictingServerSubscriptionId }
      : {}),
    ...(row.deliveryStatus !== undefined
      ? { deliveryStatus: row.deliveryStatus }
      : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    consecutiveFailures: row.consecutiveFailures ?? 0,
    ...(row.lastGapAt !== undefined ? { lastGapAt: row.lastGapAt } : {}),
    locality: row.locality ?? "hosted",
    ...(row.overrides?.length ? { overrides: row.overrides } : {}),
  };
}

/** The hosted server id for a project server, or null when it is not synced. */
export function resolveHostedEventsServerId(serverName: string): string | null {
  return tryResolveProjectServer(serverName)?.serverId ?? null;
}

// ── descriptor digest (C2 canonical JSON + SHA-256) ─────────────────────────

/**
 * RFC 8785-style canonical JSON: sorted keys, `undefined` properties
 * dropped, `-0` normalized. Mirrors `@mcpjam/evaluators`' serializer, which
 * the SDK and Convex use for every derived key.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "null";
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? "null" : canonicalJson(item)))
      .join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The descriptor a hosted subscription is created with: the event's digest
 * (`computeDescriptorHash` over the descriptor exactly as `events/list`
 * returned it), its payload schema for delivery validation, and its modes.
 * Undefined when Web Crypto is unavailable: the descriptor is optional.
 */
export async function buildHostedEventDescriptor(
  descriptor: EventDescriptorView,
): Promise<HostedEventDescriptor | undefined> {
  try {
    const hash = await sha256Hex(canonicalJson(descriptor));
    return {
      hash,
      ...(descriptor.payloadSchema
        ? { payloadSchema: descriptor.payloadSchema }
        : {}),
      delivery: [...descriptor.delivery],
    };
  } catch {
    return undefined;
  }
}
