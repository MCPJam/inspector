/**
 * Shared types for the MCP Events coordinator (contract C9) and its ports.
 *
 * Everything here is transport-independent: the coordinator core in
 * `coordinator.ts` never sees a socket, a Convex client or a Durable Object.
 * Local and hosted runtimes supply the ports.
 */

import type { EventsProfileId } from "./profiles.js";
import type { EventRunNamespace } from "./identity.js";
import type {
  EventOccurrenceWire,
  EventsListResultWire,
  EventsNestedErrorWire,
  EventsPollResultWire,
  EventsSubscribeResultWire,
} from "../mcp-client-manager/events-ext-schemas.js";
import type {
  EventsPollParams,
  EventsSubscribeParams,
  EventsUnsubscribeOutcome,
} from "../mcp-client-manager/events-ext.js";

export type SubscriptionMode = "webhook" | "poll" | "push";
export type DesiredState = "active" | "paused" | "removed";
export type ObservedState =
  | "pending"
  | "active"
  | "paused"
  | "error"
  | "terminated"
  | "paused_auth"
  | "removing"
  | "removed";

export interface SubscriptionFailure {
  kind: string;
  message: string;
  at: number;
  retryable: boolean;
}

/**
 * One logical subscription (contract C4), as the coordinator sees it. The
 * hosted registry row carries more (lease, owner, timestamps); the
 * coordinator reads only these fields and writes only a patch of them.
 */
export interface SubscriptionRecord {
  /** Logical subscription id (`esub_…`) — stable across refreshes. */
  id: string;
  projectId: string;
  environmentId: string | null;
  bindingKey: string;
  serverId: string;
  profile: EventsProfileId;
  eventName: string;
  arguments: Record<string, unknown>;
  mode: SubscriptionMode;
  desiredState: DesiredState;
  observedState: ObservedState;
  generation: number;
  nextActionAt: number;
  refreshBefore?: number | null;
  lastCursor?: string | null;
  inboxId?: string;
  slotId?: string;
  callbackUrl?: string;
  serverSubscriptionId?: string;
  conflictingServerSubscriptionId?: string;
  deliveryStatus?: unknown;
  lastError?: SubscriptionFailure;
  consecutiveFailures: number;
  removalUnsubscribedAt?: number;
  settledRemovalAt?: number;
  rotation?: { phase: "requested" | "rotated"; at: number };
  lastHealthCheckAt?: number;
  lastGapAt?: number;
  terminatedError?: EventsNestedErrorWire;
  maxAgeMs?: number;
  /** `undefined` = server default; `null` = request no expiry. */
  ttlMs?: number | null;
}

/** The fields a coordinator step may change. Never identity or desire. */
export type SubscriptionPatch = Partial<
  Pick<
    SubscriptionRecord,
    | "observedState"
    | "nextActionAt"
    | "refreshBefore"
    | "lastCursor"
    | "inboxId"
    | "slotId"
    | "callbackUrl"
    | "serverSubscriptionId"
    | "conflictingServerSubscriptionId"
    | "deliveryStatus"
    | "lastError"
    | "consecutiveFailures"
    | "removalUnsubscribedAt"
    | "settledRemovalAt"
    | "rotation"
    | "lastHealthCheckAt"
    | "lastGapAt"
    | "terminatedError"
  >
>;

/** The MCP side, bound to ONE subscription's connection binding. */
export interface EventsRpcPort {
  list(params?: { cursor?: string }): Promise<EventsListResultWire>;
  poll(params: EventsPollParams): Promise<EventsPollResultWire>;
  subscribe(params: EventsSubscribeParams): Promise<EventsSubscribeResultWire>;
  unsubscribe(params: {
    name: string;
    arguments: Record<string, unknown>;
    delivery: { url: string };
  }): Promise<EventsUnsubscribeOutcome>;
}

export type EventOrigin = "webhook" | "poll" | "push" | "simulation" | "replay";

/** One entry appended to the inbox by a non-webhook adapter. */
export type InboxAppendEntry =
  | EventOccurrenceWire
  | { type: "gap"; cursor: string | null }
  | { type: "terminated"; error: EventsNestedErrorWire };

export interface InboxSlotAllocation {
  inboxId: string;
  slotId: string;
  callbackUrl: string;
  secret: string;
}

/** The inbox side (contract C5 admin API), for one project inbox. */
export interface InboxPort {
  allocateSlot(args: {
    logicalSubscriptionId: string;
    projectId: string;
    environmentId: string | null;
    bindingKey: string;
    dispatch: boolean;
  }): Promise<InboxSlotAllocation>;
  getSecret(slotId: string): Promise<{ secret: string; previousSecret?: string }>;
  reconcile(
    slotId: string,
    serverSubscriptionId: string
  ): Promise<{ state: string; conflict?: { existing: string; proposed: string } }>;
  rotate(slotId: string): Promise<{ secret: string }>;
  retirePrevious(slotId: string): Promise<void>;
  remove(slotId: string): Promise<void>;
  append(args: {
    slotId?: string;
    logicalSubscriptionId: string;
    projectId: string;
    environmentId: string | null;
    bindingKey: string;
    batchId: string;
    origin: EventOrigin;
    namespace?: EventRunNamespace;
    entries: InboxAppendEntry[];
  }): Promise<{ accepted: number; duplicates: number }>;
}

/** Thrown by an {@link InboxPort} when the inbox applies backpressure. */
export class InboxBackpressureError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Event inbox is full; retry after ${retryAfterMs} ms`);
    this.name = "InboxBackpressureError";
  }
}

/**
 * The internal envelope every mode is normalized into before it reaches a
 * consumer (feed, trigger runner, CLI). Modes that never call
 * `events/subscribe` are not dressed up as if they did: `slotId` and
 * `serverSubscriptionId` are simply absent for poll, push and simulation.
 */
export interface EventEnvelope {
  kind: "event" | "gap" | "terminated";
  origin: EventOrigin;
  namespace: EventRunNamespace;
  logicalSubscriptionId: string;
  slotId?: string;
  serverSubscriptionId?: string | null;
  eventId?: string;
  name?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  cursor: string | null;
  webhookId?: string;
  error?: EventsNestedErrorWire;
  receivedAt: number;
}
