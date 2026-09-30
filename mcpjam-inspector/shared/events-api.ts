/**
 * Wire shapes for the inspector's MCP Events routes (`/api/mcp/events/*`
 * locally, `/api/web/events/*` hosted) and the observation stream the Events
 * tab reads.
 *
 * Declared structurally here — like `subscription-bridge.ts` — rather than
 * re-exported from `@mcpjam/sdk/events`, so the client bundle never pulls the
 * coordinator in for types. The SDK is the source of truth for the WIRE
 * (`events-ext-schemas.ts`); these are the inspector's own route contracts.
 *
 * Nothing here ever carries a webhook secret, an inbox admin token or a
 * viewer token outside `EventsViewerTokenResponse` (contract C8).
 */

export type EventsProfileIdView = "draft@28ec35e" | "chatgpt@2026-09-30";
export type EventsDeliveryModeView = "poll" | "push" | "webhook";

export interface EventsSupportView {
  handshakeObserved: boolean;
  declared: boolean;
  listChanged: boolean;
  capability?: Record<string, unknown>;
  source?: "initialize" | "server/discover";
}

export interface EventDescriptorView {
  name: string;
  description?: string;
  delivery: string[];
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface EventsListResponse {
  events: EventDescriptorView[];
  nextCursor?: string;
  support: EventsSupportView;
  /** Raw `capabilities` from the handshake, for display. */
  rawCapabilities?: Record<string, unknown>;
  protocolVersion?: string;
}

export interface EventOccurrenceView {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: string | null;
}

export interface EventsPollRequest {
  serverId: string;
  name: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface EventsPollResponse {
  events: EventOccurrenceView[];
  cursor?: string | null;
  truncated?: boolean;
  hasMore?: boolean;
  nextPollMs?: number;
}

export type EventsObservedStateView =
  | "pending"
  | "active"
  | "paused"
  | "error"
  | "terminated"
  | "paused_auth"
  | "removing"
  | "removed";

/**
 * A subscription as the Events tab shows it — local runtime or hosted
 * registry row, same shape. `callbackUrl` is shown (it is routing, not a
 * credential, contract C3); the slot's secret never is.
 */
export interface EventsSubscriptionView {
  id: string;
  /**
   * The logical subscription id (`esub_…`) feed entries carry as
   * `logicalSubscriptionId`, when it differs from `id` (a hosted registry
   * row's `id` is its Convex document id). Absent means `id` is the logical id.
   */
  logicalId?: string;
  serverId: string;
  eventName: string;
  arguments: Record<string, unknown>;
  mode: EventsDeliveryModeView;
  profile: EventsProfileIdView;
  desiredState: "active" | "paused" | "removed";
  observedState: EventsObservedStateView;
  generation: number;
  nextActionAt?: number;
  refreshBefore?: number | null;
  lastCursor?: string | null;
  callbackUrl?: string;
  serverSubscriptionId?: string;
  conflictingServerSubscriptionId?: string;
  deliveryStatus?: unknown;
  lastError?: { kind: string; message: string; at: number; retryable: boolean };
  consecutiveFailures: number;
  lastGapAt?: number;
  locality: "local" | "hosted";
  /** Labelled development overrides in effect (never a conformance pass). */
  overrides?: Array<"insecure-local-receiver">;
}

export interface EventsCreateSubscriptionRequest {
  serverId: string;
  eventName: string;
  arguments: Record<string, unknown>;
  mode: EventsDeliveryModeView;
  profile: EventsProfileIdView;
  maxAgeMs?: number;
  ttlMs?: number | null;
  /**
   * Development overrides the user explicitly acknowledged. A LOCAL webhook
   * subscription needs `["insecure-local-receiver"]`: the local development
   * receiver is plain http on the inspector's own port, never a conformance
   * pass, so the UI only sends webhook mode locally with this set.
   */
  overrides?: Array<"insecure-local-receiver">;
}

/** One journal entry, as the feed carries it. */
export interface EventsFeedEntryView {
  seq: number;
  kind: "event" | "gap" | "terminated" | "inbox_gap" | "quarantined" | string;
  origin: "webhook" | "poll" | "push" | "simulation" | "replay";
  namespace: string;
  logicalSubscriptionId: string;
  slotId?: string;
  serverSubscriptionId?: string | null;
  eventId?: string;
  name?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  cursor?: string | null;
  receivedAt: number;
  dispatch?: "pending" | "acked" | "none" | string;
  dispatchOutcome?: string;
  idConflict?: boolean;
  webhookIdMismatch?: boolean;
  quarantined?: boolean;
  error?: { code: number; message: string; data?: unknown };
}

export interface EventsRejectionView {
  reason: string;
  slotId?: string;
  at: number;
  headerNames: string[];
  bodyBytes: number;
}

/** Frames on `GET /api/mcp/events/stream` (SSE, one JSON object per frame). */
export type EventsStreamFrame =
  | { type: "snapshot"; subscriptions: EventsSubscriptionView[]; nextAfter: number }
  | { type: "entry"; entry: EventsFeedEntryView }
  | { type: "subscription"; subscription: EventsSubscriptionView }
  | { type: "rejection"; rejection: EventsRejectionView };

export interface EventsSimulateRequest {
  subscriptionId: string;
  event: {
    eventId?: string;
    name?: string;
    timestamp?: string;
    data: Record<string, unknown>;
  };
}

/** Hosted feed access: a short-lived viewer token for the public inbox. */
export interface EventsViewerTokenResponse {
  inboxId: string;
  token: string;
  expiresAt: number;
  /** `GET` JSON backlog: `${feedUrl}?after=<seq>` with `Authorization: Bearer`. */
  feedUrl: string;
  /** SSE: `${streamUrl}?after=<seq>&token=<token>` (EventSource cannot set headers). */
  streamUrl: string;
}

export interface EventsSlotStateResponse {
  state: string;
  serverSubscriptionId?: string;
  observedSubscriptionIds?: string[];
  counts?: Record<string, number>;
  rejections: EventsRejectionView[];
}

/** Error codes the events routes answer with (`{ code, message }`). */
export type EventsRouteErrorCode =
  | "EVENTS_UNDECLARED"
  | "EVENTS_INVALID_PAYLOAD"
  | "EVENTS_RPC_ERROR"
  | "EVENTS_NOT_FOUND"
  | "EVENTS_UNAVAILABLE";
