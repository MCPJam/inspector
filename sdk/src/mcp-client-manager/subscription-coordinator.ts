/**
 * Era-neutral subscription coordinator (MCP 2026-07-28 `subscriptions/listen`).
 *
 * ## Why this is not "the legacy model plus a new RPC"
 *
 * The 2025-era model is a *set of subscribed resource URIs* plus unsolicited
 * list-changed notifications that arrive on whatever channel the transport
 * happens to keep open. There is no stream identity, no acknowledgement, no
 * close reason, and no way for a debugger to show what the server actually
 * agreed to send.
 *
 * The 2026-07-28 model is a *long-lived, explicitly-filtered stream*: the
 * client sends `subscriptions/listen` with a filter, the server replies with
 * `notifications/subscriptions/acknowledged` carrying the subset it agreed to
 * honor, every subsequent notification is stamped with the subscription id,
 * and the stream ends either gracefully (an empty `subscriptions/listen`
 * result), remotely (transport loss, no result), or locally (client abort).
 *
 * So the product state model here is era-neutral and adapter-specific:
 *
 *   - **Desired interests** — what the user wants, independent of era:
 *     tools/prompts/resources list-changed toggles plus a set of resource URIs
 *     ({@link DesiredSubscriptionInterests}).
 *   - **Streams** — zero or more {@link SubscriptionStreamRecord}s, each with a
 *     local MCPJam id, the MCP subscription id (when known), the *requested*
 *     filter, the *acknowledged* filter (tracked separately — they are not the
 *     same fact), a status, lifecycle timestamps, and a reconnect attempt
 *     counter.
 *   - **Legacy adapter** — the existing list-changed handlers plus
 *     `resources/subscribe` / `resources/unsubscribe` per URI, modelled as one
 *     synthetic stream so the debugger has a single shape to render.
 *   - **Modern adapter** — an explicit `client.listen(filter)`. Resource URIs
 *     ride in `resourceSubscriptions`. Changing the desired filter closes and
 *     reopens the stream (a filter is fixed for the life of a subscription);
 *     an unexpected remote loss triggers a bounded re-*listen* — never a
 *     resume, since there is no `Last-Event-ID`/replay for listen streams.
 *
 * ## Deliberate choices
 *
 * - **Explicit `listen()` over `ClientOptions.listChanged`.** The auto-opened
 *   subscription hides the requested filter, the subscription identity, the
 *   ack timing and the close reason — exactly the facts a debugger exists to
 *   show. MCPJam always drives `listen()` itself.
 * - **Advertise = enforce, and show the absence.** A selection the server does
 *   not advertise is *omitted* from the requested filter and recorded as
 *   {@link SubscriptionInterestRejection} so the UI can render it as rejected
 *   rather than silently dropping it.
 * - **Ack before active.** A stream stays `opening` until the acknowledgement
 *   is observed; only then does it become `active` with an acknowledged filter.
 * - **Handlers registered once, demultiplexed by subscription id.** Multiple
 *   concurrent subscriptions are legal, so per-stream handler registration
 *   would fan a single notification out to the wrong streams.
 * - **Unrequested notification types are rejected**, recorded, and not
 *   delivered.
 * - **Request-scoped notifications stay out of this store.** `notifications/
 *   progress` and `notifications/message` belong to the originating request
 *   stream; the coordinator never registers handlers for them, and rejects
 *   them if a caller asks for them.
 *
 * All exports in this module are new; nothing existing changes shape.
 */

import type { ServerCapabilities } from "@modelcontextprotocol/client";

/**
 * `_meta` key carrying the JSON-RPC id of the `subscriptions/listen` request a
 * notification was delivered on. Mirrors upstream `SUBSCRIPTION_ID_META_KEY`;
 * re-declared locally so this module has no value import from the client
 * package (it is type-only elsewhere) and so the constant is assertable in
 * tests without pulling the SDK's internal entrypoint.
 */
export const SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId";

export const SubscriptionsAcknowledgedNotificationMethod =
  "notifications/subscriptions/acknowledged" as const;
export const ToolListChangedNotificationMethod =
  "notifications/tools/list_changed" as const;
export const PromptListChangedNotificationMethod =
  "notifications/prompts/list_changed" as const;
export const ResourceListChangedNotificationMethod =
  "notifications/resources/list_changed" as const;
export const ResourceUpdatedNotificationMethod =
  "notifications/resources/updated" as const;

/** The notification kinds this coordinator owns. */
export type SubscriptionNotificationKind =
  | "tools-list-changed"
  | "prompts-list-changed"
  | "resources-list-changed"
  | "resource-updated";

const METHOD_TO_KIND: Readonly<
  Record<string, SubscriptionNotificationKind>
> = {
  [ToolListChangedNotificationMethod]: "tools-list-changed",
  [PromptListChangedNotificationMethod]: "prompts-list-changed",
  [ResourceListChangedNotificationMethod]: "resources-list-changed",
  [ResourceUpdatedNotificationMethod]: "resource-updated",
};

/** Product-level, era-neutral statement of what the user wants to observe. */
export interface DesiredSubscriptionInterests {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** Resource URIs to watch for `notifications/resources/updated`. */
  resourceUris?: readonly string[];
}

/** Wire-shaped filter (structurally the SDK's `SubscriptionFilter`). */
export interface SubscriptionFilterShape {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

export type SubscriptionStreamStatus =
  | "opening"
  | "active"
  | "graceful-closed"
  | "remote-closed"
  | "cancelled"
  | "error";

/** Why a stream ended, mapped from the SDK's `McpSubscription.closed`. */
export type SubscriptionCloseReason =
  /** Server completed the subscription intentionally (empty listen result). */
  | "graceful"
  /** Unexpected loss with no completion result — eligible for re-listen. */
  | "remote"
  /** We closed it (desired filter changed, disposal, explicit cancel). */
  | "local-abort"
  /** The open itself failed (pre-ack rejection, timeout, transport error). */
  | "error";

/**
 * A selection the server does not advertise. Kept in the stream record so the
 * debugger can show it as *rejected*, rather than the selection just quietly
 * not appearing in the acknowledged filter.
 */
export interface SubscriptionInterestRejection {
  interest: SubscriptionNotificationKind;
  /** Present for `resource-updated` rejections. */
  uri?: string;
  reason: "capability-not-advertised" | "not-acknowledged-by-server";
}

/** A notification the coordinator refused to deliver, kept for the debugger. */
export interface RejectedSubscriptionNotification {
  method: string;
  subscriptionId?: string;
  /** Local stream id, when the notification could be attributed to one. */
  localSubscriptionId?: string;
  reason:
    | "unrequested-type"
    | "unknown-subscription-id"
    | "stream-not-active"
    | "request-scoped-notification";
  at: number;
}

/** One long-lived notification stream, era-neutral. */
export interface SubscriptionStreamRecord {
  /** MCPJam-local identity; stable across the record's whole lifetime. */
  readonly localId: string;
  readonly era: "legacy" | "modern";
  /**
   * The MCP JSON-RPC subscription id (the listen request's id). `undefined`
   * on the legacy era, and on the modern era until an ack/notification
   * reveals it.
   */
  mcpSubscriptionId?: string;
  /** How `mcpSubscriptionId` became known. */
  idBinding?: "reported" | "observed";
  requestedFilter: SubscriptionFilterShape;
  /** Only set once the acknowledgement is observed. Never inferred. */
  acknowledgedFilter?: SubscriptionFilterShape;
  rejectedInterests: SubscriptionInterestRejection[];
  status: SubscriptionStreamStatus;
  closeReason?: SubscriptionCloseReason;
  error?: string;
  openedAt: number;
  acknowledgedAt?: number;
  closedAt?: number;
  /** How many re-listens have been attempted after a remote loss. */
  reconnectAttempt: number;
}

/** A notification the coordinator accepted and attributed to a stream. */
export interface DeliveredSubscriptionNotification {
  method: string;
  kind: SubscriptionNotificationKind;
  params?: Record<string, unknown>;
  /** Resource URI for `resource-updated`. */
  uri?: string;
  subscriptionId?: string;
  localSubscriptionId: string;
  at: number;
}

/** Minimal handle shape; upstream `McpSubscription` satisfies it structurally. */
export interface McpSubscriptionHandle {
  readonly honoredFilter: SubscriptionFilterShape;
  close(): Promise<void>;
  readonly closed: Promise<"local" | "graceful" | "remote">;
  /**
   * The listen request's JSON-RPC id, when the implementation exposes it.
   * Upstream beta.4 does not; the coordinator then binds the id from the
   * first stamped message on the stream.
   */
  readonly subscriptionId?: string;
}

/**
 * The client surface the coordinator needs. `ManagedMcpClient` satisfies it
 * structurally (its `listen` is optional too), so the coordinator can be
 * driven by the managed client, by upstream `Client`, or by a test fixture.
 */
export interface SubscriptionClientPort {
  getServerCapabilities(): ServerCapabilities | undefined;
  getProtocolEra?(): "legacy" | "modern" | undefined;
  setNotificationHandler(
    method: string,
    handler: (notification: {
      method: string;
      params?: Record<string, unknown>;
    }) => void
  ): void;
  subscribeResource(params: { uri: string }): Promise<unknown>;
  unsubscribeResource(params: { uri: string }): Promise<unknown>;
  listen?(filter: SubscriptionFilterShape): Promise<McpSubscriptionHandle>;
}

/** Bounded re-listen policy. Re-listen, never resume: no replay exists. */
export interface SubscriptionReconnectPolicy {
  /** Max re-listens after a *remote* loss. 0 disables reconnection. */
  maxAttempts: number;
  initialDelayMs: number;
  factor: number;
  maxDelayMs: number;
}

export const DEFAULT_SUBSCRIPTION_RECONNECT_POLICY: SubscriptionReconnectPolicy =
  {
    maxAttempts: 3,
    initialDelayMs: 500,
    factor: 2,
    maxDelayMs: 5_000,
  };

export interface SubscriptionCoordinatorOptions {
  client: SubscriptionClientPort;
  /**
   * Era override. When omitted the coordinator asks the client
   * (`getProtocolEra()`), defaulting to `"legacy"` when the client cannot say
   * — an unknown era must never opt into modern-only behavior.
   */
  era?: "legacy" | "modern";
  reconnect?: Partial<SubscriptionReconnectPolicy>;
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Injected for deterministic tests; must resolve after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  /** Stream-state changes (open/ack/close/reconnect). */
  onStreamChange?: (stream: SubscriptionStreamRecord) => void;
  /** Accepted notifications, already attributed to a stream. */
  onNotification?: (event: DeliveredSubscriptionNotification) => void;
  /** Refused notifications, surfaced so the debugger can show the refusal. */
  onRejectedNotification?: (event: RejectedSubscriptionNotification) => void;
  /**
   * Staleness hook. Invoked AFTER `onNotification`, never instead of it: a
   * product-level refresh policy must not be able to hide the notification
   * that triggered it.
   */
  onStale?: (event: DeliveredSubscriptionNotification) => void;
}

function cloneFilter(filter: SubscriptionFilterShape): SubscriptionFilterShape {
  return {
    ...filter,
    ...(filter.resourceSubscriptions
      ? { resourceSubscriptions: [...filter.resourceSubscriptions] }
      : {}),
  };
}

function filtersEqual(
  a: SubscriptionFilterShape,
  b: SubscriptionFilterShape
): boolean {
  const uris = (f: SubscriptionFilterShape) =>
    [...(f.resourceSubscriptions ?? [])].sort().join("\u0000");
  return (
    Boolean(a.toolsListChanged) === Boolean(b.toolsListChanged) &&
    Boolean(a.promptsListChanged) === Boolean(b.promptsListChanged) &&
    Boolean(a.resourcesListChanged) === Boolean(b.resourcesListChanged) &&
    uris(a) === uris(b)
  );
}

function isEmptyFilter(filter: SubscriptionFilterShape): boolean {
  return (
    !filter.toolsListChanged &&
    !filter.promptsListChanged &&
    !filter.resourcesListChanged &&
    (filter.resourceSubscriptions?.length ?? 0) === 0
  );
}

function filterAllows(
  filter: SubscriptionFilterShape,
  kind: SubscriptionNotificationKind,
  uri?: string
): boolean {
  switch (kind) {
    case "tools-list-changed":
      return Boolean(filter.toolsListChanged);
    case "prompts-list-changed":
      return Boolean(filter.promptsListChanged);
    case "resources-list-changed":
      return Boolean(filter.resourcesListChanged);
    case "resource-updated": {
      const uris = filter.resourceSubscriptions ?? [];
      // A server may legitimately stamp an update for a URI whose exact form
      // differs only by template expansion; MCPJam does not guess — the URI
      // must be one we asked for.
      return uri !== undefined && uris.includes(uri);
    }
  }
}

/**
 * Splits desired interests into the filter we will actually request and the
 * selections the server does not advertise (shown as rejected, not dropped).
 */
export function resolveRequestedFilter(
  desired: DesiredSubscriptionInterests,
  capabilities: ServerCapabilities | undefined
): {
  requested: SubscriptionFilterShape;
  rejected: SubscriptionInterestRejection[];
} {
  const caps = (capabilities ?? {}) as {
    tools?: { listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    resources?: { listChanged?: boolean; subscribe?: boolean };
  };
  const requested: SubscriptionFilterShape = {};
  const rejected: SubscriptionInterestRejection[] = [];

  const take = (
    want: boolean | undefined,
    supported: boolean | undefined,
    interest: SubscriptionNotificationKind,
    key: "toolsListChanged" | "promptsListChanged" | "resourcesListChanged"
  ) => {
    if (!want) return;
    if (supported) {
      requested[key] = true;
    } else {
      rejected.push({ interest, reason: "capability-not-advertised" });
    }
  };

  take(
    desired.toolsListChanged,
    caps.tools?.listChanged,
    "tools-list-changed",
    "toolsListChanged"
  );
  take(
    desired.promptsListChanged,
    caps.prompts?.listChanged,
    "prompts-list-changed",
    "promptsListChanged"
  );
  take(
    desired.resourcesListChanged,
    caps.resources?.listChanged,
    "resources-list-changed",
    "resourcesListChanged"
  );

  const uris = [...new Set(desired.resourceUris ?? [])];
  if (uris.length > 0) {
    if (caps.resources?.subscribe) {
      requested.resourceSubscriptions = uris;
    } else {
      for (const uri of uris) {
        rejected.push({
          interest: "resource-updated",
          uri,
          reason: "capability-not-advertised",
        });
      }
    }
  }

  return { requested, rejected };
}

/**
 * Selections that were requested but absent from the acknowledgement. The
 * server is allowed to honor a subset; the difference is a first-class,
 * displayable fact rather than an invisible no-op.
 */
export function diffAcknowledgement(
  requested: SubscriptionFilterShape,
  acknowledged: SubscriptionFilterShape
): SubscriptionInterestRejection[] {
  const rejected: SubscriptionInterestRejection[] = [];
  const pairs: Array<
    [keyof SubscriptionFilterShape, SubscriptionNotificationKind]
  > = [
    ["toolsListChanged", "tools-list-changed"],
    ["promptsListChanged", "prompts-list-changed"],
    ["resourcesListChanged", "resources-list-changed"],
  ];
  for (const [key, interest] of pairs) {
    if (requested[key] && !acknowledged[key]) {
      rejected.push({ interest, reason: "not-acknowledged-by-server" });
    }
  }
  const acked = new Set(acknowledged.resourceSubscriptions ?? []);
  for (const uri of requested.resourceSubscriptions ?? []) {
    if (!acked.has(uri)) {
      rejected.push({
        interest: "resource-updated",
        uri,
        reason: "not-acknowledged-by-server",
      });
    }
  }
  return rejected;
}

let coordinatorSeq = 0;

/**
 * Shared, era-aware subscription coordinator. One instance per connected
 * server; owns the desired interests, the live stream(s), and the single set
 * of notification handler registrations.
 */
export class SubscriptionCoordinator {
  private readonly client: SubscriptionClientPort;
  private readonly options: SubscriptionCoordinatorOptions;
  private readonly reconnectPolicy: SubscriptionReconnectPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly instanceId: string;

  private desired: DesiredSubscriptionInterests = {};
  private handlersRegistered = false;
  private disposed = false;
  private streamSeq = 0;
  /** Local id → record. Insertion-ordered; closed records are retained. */
  private readonly streams = new Map<string, SubscriptionStreamRecord>();
  /** Local id → live handle (modern only). */
  private readonly handles = new Map<string, McpSubscriptionHandle>();
  /** MCP subscription id → local id. */
  private readonly idIndex = new Map<string, string>();
  /** Local id of the currently intended stream, if any. */
  private currentLocalId?: string;
  /** Serializes reconcile/close/reopen so filter churn cannot interleave. */
  private queue: Promise<void> = Promise.resolve();
  private readonly rejections: RejectedSubscriptionNotification[] = [];
  /** Legacy adapter bookkeeping: URIs currently `resources/subscribe`d. */
  private legacySubscribedUris = new Set<string>();

  constructor(options: SubscriptionCoordinatorOptions) {
    this.options = options;
    this.client = options.client;
    this.reconnectPolicy = {
      ...DEFAULT_SUBSCRIPTION_RECONNECT_POLICY,
      ...(options.reconnect ?? {}),
    };
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.instanceId = `mcpjam-sub-${++coordinatorSeq}`;
  }

  /**
   * The negotiated era. Unknown ⇒ `"legacy"`: modern-only behavior is never
   * applied on a guess.
   */
  get era(): "legacy" | "modern" {
    return this.options.era ?? this.client.getProtocolEra?.() ?? "legacy";
  }

  getDesiredInterests(): DesiredSubscriptionInterests {
    return {
      ...this.desired,
      ...(this.desired.resourceUris
        ? { resourceUris: [...this.desired.resourceUris] }
        : {}),
    };
  }

  /** Every stream this coordinator has opened, newest last. */
  getStreams(): SubscriptionStreamRecord[] {
    return [...this.streams.values()].map((s) => ({
      ...s,
      requestedFilter: cloneFilter(s.requestedFilter),
      ...(s.acknowledgedFilter
        ? { acknowledgedFilter: cloneFilter(s.acknowledgedFilter) }
        : {}),
      rejectedInterests: [...s.rejectedInterests],
    }));
  }

  getActiveStream(): SubscriptionStreamRecord | undefined {
    return this.getStreams().find((s) => s.status === "active");
  }

  getRejectedNotifications(): RejectedSubscriptionNotification[] {
    return [...this.rejections];
  }

  /**
   * Declares what the user wants. Idempotent: an unchanged effective filter
   * leaves the live stream alone. A changed filter closes the current stream
   * (`local-abort`) and opens a new one — a listen filter is immutable for the
   * life of a subscription.
   */
  async setDesiredInterests(
    desired: DesiredSubscriptionInterests
  ): Promise<void> {
    this.desired = {
      ...desired,
      ...(desired.resourceUris ? { resourceUris: [...desired.resourceUris] } : {}),
    };
    await this.enqueue(() => this.reconcile());
  }

  /** Explicit user-driven teardown. Ends the stream as `cancelled`. */
  async cancel(): Promise<void> {
    this.desired = {};
    await this.enqueue(() => this.reconcile());
  }

  /** Terminal teardown. No further reconnects; handlers stay harmlessly bound. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.desired = {};
    await this.enqueue(() => this.reconcile());
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    // Keep the chain alive even if a task rejects; failures surface on the
    // stream record, not as an unhandled rejection.
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---- Handler registration (ONCE, demux by subscription id) ----

  private ensureHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;
    for (const method of Object.keys(METHOD_TO_KIND)) {
      this.client.setNotificationHandler(method, (notification) =>
        this.handleNotification(notification)
      );
    }
    this.client.setNotificationHandler(
      SubscriptionsAcknowledgedNotificationMethod,
      (notification) => this.handleAcknowledgement(notification)
    );
  }

  private readSubscriptionId(
    params: Record<string, unknown> | undefined
  ): string | undefined {
    const meta = params?._meta as Record<string, unknown> | undefined;
    const raw = meta?.[SUBSCRIPTION_ID_META_KEY];
    return typeof raw === "string"
      ? raw
      : typeof raw === "number"
        ? String(raw)
        : undefined;
  }

  /**
   * Binds an MCP subscription id to a local stream. Upstream beta.4's
   * `McpSubscription` does not expose the listen id, so when the handle cannot
   * report it we adopt the id off the first stamped message of the only stream
   * still awaiting a binding. With more than one such stream the attribution
   * would be a guess, so we refuse and record the notification as
   * `unknown-subscription-id` instead.
   */
  private resolveStream(
    subscriptionId: string | undefined
  ): SubscriptionStreamRecord | undefined {
    if (this.era === "legacy") {
      return this.currentLocalId
        ? this.streams.get(this.currentLocalId)
        : undefined;
    }
    if (!subscriptionId) return undefined;
    const known = this.idIndex.get(subscriptionId);
    if (known) return this.streams.get(known);

    const unbound = [...this.streams.values()].filter(
      (s) =>
        s.mcpSubscriptionId === undefined &&
        (s.status === "opening" || s.status === "active")
    );
    if (unbound.length !== 1) return undefined;
    const stream = unbound[0];
    stream.mcpSubscriptionId = subscriptionId;
    stream.idBinding = "observed";
    this.idIndex.set(subscriptionId, stream.localId);
    return stream;
  }

  private handleAcknowledgement(notification: {
    method: string;
    params?: Record<string, unknown>;
  }): void {
    const subscriptionId = this.readSubscriptionId(notification.params);
    const stream = this.resolveStream(subscriptionId);
    if (!stream) {
      this.recordRejection({
        method: notification.method,
        subscriptionId,
        reason: "unknown-subscription-id",
        at: this.now(),
      });
      return;
    }
    const acknowledged =
      ((notification.params?.notifications as SubscriptionFilterShape) ??
        undefined) ?? {};
    this.markAcknowledged(stream, acknowledged);
  }

  private markAcknowledged(
    stream: SubscriptionStreamRecord,
    acknowledged: SubscriptionFilterShape
  ): void {
    if (stream.acknowledgedFilter) return;
    stream.acknowledgedFilter = cloneFilter(acknowledged);
    stream.rejectedInterests = [
      ...stream.rejectedInterests,
      ...diffAcknowledgement(stream.requestedFilter, acknowledged),
    ];
    stream.acknowledgedAt = this.now();
    if (stream.status === "opening") {
      stream.status = "active";
    }
    this.emitStream(stream);
  }

  private handleNotification(notification: {
    method: string;
    params?: Record<string, unknown>;
  }): void {
    const at = this.now();
    const kind = METHOD_TO_KIND[notification.method];
    if (!kind) {
      // Request-scoped notifications (progress, log records) belong to the
      // originating request stream and never enter this store.
      this.recordRejection({
        method: notification.method,
        reason: "request-scoped-notification",
        at,
      });
      return;
    }
    const subscriptionId = this.readSubscriptionId(notification.params);
    const stream = this.resolveStream(subscriptionId);
    if (!stream) {
      this.recordRejection({
        method: notification.method,
        subscriptionId,
        reason: "unknown-subscription-id",
        at,
      });
      return;
    }
    if (stream.status !== "active") {
      // Ack gates delivery: anything before the acknowledgement (or after a
      // close) is not part of an established subscription.
      this.recordRejection({
        method: notification.method,
        subscriptionId,
        localSubscriptionId: stream.localId,
        reason: "stream-not-active",
        at,
      });
      return;
    }
    const uri =
      typeof notification.params?.uri === "string"
        ? (notification.params.uri as string)
        : undefined;
    // Enforce against the ACKNOWLEDGED filter: the server must not send a type
    // it did not agree to honor.
    const effective = stream.acknowledgedFilter ?? stream.requestedFilter;
    if (!filterAllows(effective, kind, uri)) {
      this.recordRejection({
        method: notification.method,
        subscriptionId,
        localSubscriptionId: stream.localId,
        reason: "unrequested-type",
        at,
      });
      return;
    }

    const event: DeliveredSubscriptionNotification = {
      method: notification.method,
      kind,
      params: notification.params,
      ...(uri ? { uri } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      localSubscriptionId: stream.localId,
      at,
    };
    // Deliver first, mark stale second — a refresh policy must never be able
    // to swallow the notification that triggered it.
    this.options.onNotification?.(event);
    this.options.onStale?.(event);
  }

  private recordRejection(event: RejectedSubscriptionNotification): void {
    this.rejections.push(event);
    this.options.onRejectedNotification?.(event);
  }

  private emitStream(stream: SubscriptionStreamRecord): void {
    this.options.onStreamChange?.({
      ...stream,
      requestedFilter: cloneFilter(stream.requestedFilter),
      ...(stream.acknowledgedFilter
        ? { acknowledgedFilter: cloneFilter(stream.acknowledgedFilter) }
        : {}),
      rejectedInterests: [...stream.rejectedInterests],
    });
  }

  // ---- Reconciliation ----

  private async reconcile(): Promise<void> {
    const { requested, rejected } = resolveRequestedFilter(
      this.desired,
      this.client.getServerCapabilities()
    );
    if (this.era === "legacy") {
      await this.reconcileLegacy(requested, rejected);
      return;
    }
    await this.reconcileModern(requested, rejected);
  }

  // ---- Legacy adapter: list-changed handlers + per-URI subscribe RPCs ----

  private async reconcileLegacy(
    requested: SubscriptionFilterShape,
    rejected: SubscriptionInterestRejection[]
  ): Promise<void> {
    const wantUris = new Set(requested.resourceSubscriptions ?? []);
    const current = this.currentLocalId
      ? this.streams.get(this.currentLocalId)
      : undefined;

    if (this.disposed || isEmptyFilter(requested)) {
      for (const uri of this.legacySubscribedUris) {
        await this.safeUnsubscribe(uri);
      }
      this.legacySubscribedUris.clear();
      if (current && (current.status === "active" || current.status === "opening")) {
        current.status = "cancelled";
        current.closeReason = "local-abort";
        current.closedAt = this.now();
        this.emitStream(current);
      }
      this.currentLocalId = undefined;
      return;
    }

    this.ensureHandlers();

    for (const uri of [...this.legacySubscribedUris]) {
      if (!wantUris.has(uri)) {
        await this.safeUnsubscribe(uri);
        this.legacySubscribedUris.delete(uri);
      }
    }
    const failedUris: string[] = [];
    for (const uri of wantUris) {
      if (this.legacySubscribedUris.has(uri)) continue;
      try {
        await this.client.subscribeResource({ uri });
        this.legacySubscribedUris.add(uri);
      } catch {
        failedUris.push(uri);
      }
    }

    const effective: SubscriptionFilterShape = {
      ...requested,
      ...(wantUris.size > 0
        ? { resourceSubscriptions: [...this.legacySubscribedUris] }
        : {}),
    };
    const allRejected = [
      ...rejected,
      ...failedUris.map(
        (uri): SubscriptionInterestRejection => ({
          interest: "resource-updated",
          uri,
          reason: "not-acknowledged-by-server",
        })
      ),
    ];

    if (current && current.status === "active") {
      current.requestedFilter = cloneFilter(requested);
      // The legacy era has no acknowledgement message; the successful
      // `resources/subscribe` calls plus the always-on list-changed channel
      // ARE the acknowledgement, so the two filters are recorded separately
      // but derived from the same observed facts.
      current.acknowledgedFilter = cloneFilter(effective);
      current.rejectedInterests = allRejected;
      this.emitStream(current);
      return;
    }

    const stream: SubscriptionStreamRecord = {
      localId: `${this.instanceId}-legacy-${++this.streamSeq}`,
      era: "legacy",
      requestedFilter: cloneFilter(requested),
      acknowledgedFilter: cloneFilter(effective),
      rejectedInterests: allRejected,
      status: "active",
      openedAt: this.now(),
      acknowledgedAt: this.now(),
      reconnectAttempt: 0,
    };
    this.streams.set(stream.localId, stream);
    this.currentLocalId = stream.localId;
    this.emitStream(stream);
  }

  private async safeUnsubscribe(uri: string): Promise<void> {
    try {
      await this.client.unsubscribeResource({ uri });
    } catch {
      // A failed unsubscribe must not wedge reconciliation; the server may
      // already have dropped the subscription.
    }
  }

  // ---- Modern adapter: explicit `subscriptions/listen` ----

  private async reconcileModern(
    requested: SubscriptionFilterShape,
    rejected: SubscriptionInterestRejection[]
  ): Promise<void> {
    const current = this.currentLocalId
      ? this.streams.get(this.currentLocalId)
      : undefined;
    const live =
      current &&
      (current.status === "opening" || current.status === "active")
        ? current
        : undefined;

    if (this.disposed || isEmptyFilter(requested)) {
      if (live) await this.closeStream(live, "local-abort", "cancelled");
      this.currentLocalId = undefined;
      return;
    }

    if (live && filtersEqual(live.requestedFilter, requested)) {
      return;
    }
    // A listen filter is immutable: change of desire ⇒ controlled close+reopen.
    if (live) await this.closeStream(live, "local-abort", "cancelled");
    await this.openModernStream(requested, rejected, 0);
  }

  private async openModernStream(
    requested: SubscriptionFilterShape,
    rejected: SubscriptionInterestRejection[],
    reconnectAttempt: number
  ): Promise<void> {
    const listen = this.client.listen?.bind(this.client);
    const stream: SubscriptionStreamRecord = {
      localId: `${this.instanceId}-listen-${++this.streamSeq}`,
      era: "modern",
      requestedFilter: cloneFilter(requested),
      rejectedInterests: [...rejected],
      status: "opening",
      openedAt: this.now(),
      reconnectAttempt,
    };
    this.streams.set(stream.localId, stream);
    this.currentLocalId = stream.localId;
    this.emitStream(stream);

    if (!listen) {
      stream.status = "error";
      stream.closeReason = "error";
      stream.error =
        "The connected client does not implement subscriptions/listen.";
      stream.closedAt = this.now();
      this.emitStream(stream);
      return;
    }

    this.ensureHandlers();

    let handle: McpSubscriptionHandle;
    try {
      handle = await listen(cloneFilter(requested));
    } catch (error) {
      stream.status = "error";
      stream.closeReason = "error";
      stream.error = error instanceof Error ? error.message : String(error);
      stream.closedAt = this.now();
      this.emitStream(stream);
      return;
    }

    this.handles.set(stream.localId, handle);
    if (handle.subscriptionId) {
      stream.mcpSubscriptionId = handle.subscriptionId;
      stream.idBinding = "reported";
      this.idIndex.set(handle.subscriptionId, stream.localId);
    }
    // `listen()` resolves on the acknowledgement, and `honoredFilter` IS the
    // acknowledged filter. When the ack notification also reaches our handler
    // (fixtures, or a client that does not consume it), `markAcknowledged` is
    // idempotent.
    this.markAcknowledged(stream, handle.honoredFilter ?? {});

    void handle.closed.then((reason) => this.onHandleClosed(stream, reason));
  }

  private onHandleClosed(
    stream: SubscriptionStreamRecord,
    reason: "local" | "graceful" | "remote"
  ): void {
    if (
      stream.status === "cancelled" ||
      stream.status === "graceful-closed" ||
      stream.status === "remote-closed"
    ) {
      return;
    }
    this.handles.delete(stream.localId);
    stream.closedAt = this.now();
    if (reason === "local") {
      stream.status = "cancelled";
      stream.closeReason = "local-abort";
      this.emitStream(stream);
      return;
    }
    if (reason === "graceful") {
      // The server completed the subscription on purpose (it returned the
      // empty listen result before closing). Not an error, NOT eligible for
      // an automatic re-listen.
      stream.status = "graceful-closed";
      stream.closeReason = "graceful";
      this.emitStream(stream);
      return;
    }
    // Unexpected loss: no completion result. Eligible for a bounded re-listen
    // (re-listen, not resume — there is no replay for listen streams).
    stream.status = "remote-closed";
    stream.closeReason = "remote";
    this.emitStream(stream);
    if (this.currentLocalId === stream.localId) {
      void this.enqueue(() => this.scheduleRelisten(stream));
    }
  }

  private async scheduleRelisten(
    closed: SubscriptionStreamRecord
  ): Promise<void> {
    if (this.disposed) return;
    if (this.currentLocalId !== closed.localId) return;
    const { requested, rejected } = resolveRequestedFilter(
      this.desired,
      this.client.getServerCapabilities()
    );
    if (isEmptyFilter(requested)) return;
    const attempt = closed.reconnectAttempt + 1;
    if (attempt > this.reconnectPolicy.maxAttempts) return;

    const delay = Math.min(
      this.reconnectPolicy.maxDelayMs,
      this.reconnectPolicy.initialDelayMs *
        this.reconnectPolicy.factor ** (attempt - 1)
    );
    await this.sleep(delay);
    if (this.disposed || this.currentLocalId !== closed.localId) return;
    await this.openModernStream(requested, rejected, attempt);
  }

  private async closeStream(
    stream: SubscriptionStreamRecord,
    closeReason: SubscriptionCloseReason,
    status: SubscriptionStreamStatus
  ): Promise<void> {
    const handle = this.handles.get(stream.localId);
    this.handles.delete(stream.localId);
    stream.status = status;
    stream.closeReason = closeReason;
    stream.closedAt = this.now();
    this.emitStream(stream);
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Close is best-effort and idempotent upstream; a failure here still
        // leaves the record in its terminal state.
      }
    }
  }
}
