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
// The ONE module allowed to read the tasks extension capability. Importing the
// predicate rather than re-deriving it here is what keeps the "treat the
// extension as absent on 2025-11-25" rule in a single place.
import { serverDeclaresTasksExtension } from "./tasks-dispatch.js";

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
/**
 * Optional `io.modelcontextprotocol/tasks` (SEP-2663) task notification.
 *
 * OPTIONAL is load-bearing: the extension never requires a server to send
 * these, so this channel may only ever *reduce* polling. Correctness always
 * rests on `tasks/get`, and every path below falls back to it.
 */
export const TasksNotificationMethod = "notifications/tasks" as const;

/** The notification kinds this coordinator owns. */
export type SubscriptionNotificationKind =
  | "tools-list-changed"
  | "prompts-list-changed"
  | "resources-list-changed"
  | "resource-updated"
  | "tasks";

const METHOD_TO_KIND: Readonly<Record<string, SubscriptionNotificationKind>> = {
  [ToolListChangedNotificationMethod]: "tools-list-changed",
  [PromptListChangedNotificationMethod]: "prompts-list-changed",
  [ResourceListChangedNotificationMethod]: "resources-list-changed",
  [ResourceUpdatedNotificationMethod]: "resource-updated",
  [TasksNotificationMethod]: "tasks",
};

/** Product-level, era-neutral statement of what the user wants to observe. */
export interface DesiredSubscriptionInterests {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** Resource URIs to watch for `notifications/resources/updated`. */
  resourceUris?: readonly string[];
  /**
   * Task IDs to watch for `notifications/tasks`. Extension wire only. The
   * caller is expected to drop terminal and dismissed IDs, which changes the
   * filter and therefore closes and re-opens the stream — a listen filter is
   * immutable for the life of a subscription.
   */
  taskIds?: readonly string[];
}

/**
 * Wire-shaped filter (structurally the SDK's `SubscriptionFilter`, plus the
 * extension's `taskIds`).
 *
 * `taskIds` is not in upstream's `SubscriptionFilter` type, and does not need
 * to be: `Client.listen` puts the filter on the wire verbatim
 * (`notifications: filter`, client `dist/index.mjs:3711`) with no outbound
 * schema strip, so the extension member survives the round trip.
 */
export interface SubscriptionFilterShape {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  taskIds?: string[];
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
  /** Present for `tasks` rejections. */
  taskId?: string;
  reason:
    | "capability-not-advertised"
    | "not-acknowledged-by-server"
    /**
     * A task-filtered listen was wanted but this connection cannot put the
     * extension's per-request eligibility declaration on the listen request,
     * so sending it would earn `-32021`. Polling continues; the handle is not
     * lost. See `tasks-ext-listen-meta.ts`.
     */
    | "tasks-declaration-unavailable";
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
  /** Task id for `tasks`. The params themselves are the full `DetailedTask`. */
  taskId?: string;
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
  /**
   * Opens a listen stream carrying the `io.modelcontextprotocol/tasks`
   * per-request eligibility declaration.
   *
   * Separate from {@link listen} on purpose. A task-filtered listen without
   * the declaration MUST be answered `-32021` (`tasks.md:797-799`), so a
   * connection that cannot declare must not send one at all — it drops the
   * `taskIds` selection, records it as `tasks-declaration-unavailable`, and
   * keeps polling. Absent method ⇒ exactly that.
   */
  listenWithTasksDeclaration?(
    filter: SubscriptionFilterShape
  ): Promise<McpSubscriptionHandle>;
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
    ...(filter.taskIds ? { taskIds: [...filter.taskIds] } : {}),
  };
}

/**
 * Order-insensitive comparison key for the extension's `taskIds` member.
 * `JSON.stringify` rather than a joined string: task IDs are opaque handles
 * that may contain any character, so no separator is safe to assume.
 */
function taskIds(filter: SubscriptionFilterShape): string {
  return JSON.stringify([...(filter.taskIds ?? [])].sort());
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
    uris(a) === uris(b) &&
    taskIds(a) === taskIds(b)
  );
}

function isEmptyFilter(filter: SubscriptionFilterShape): boolean {
  return (
    !filter.toolsListChanged &&
    !filter.promptsListChanged &&
    !filter.resourcesListChanged &&
    (filter.resourceSubscriptions?.length ?? 0) === 0 &&
    (filter.taskIds?.length ?? 0) === 0
  );
}

/**
 * Whether a notification is one this stream may deliver.
 *
 * Takes BOTH filters, and for the identifier-bearing kinds requires membership
 * in each. The acknowledged filter alone is not enough: `markAcknowledged`
 * stores whatever the server honored, and `diffAcknowledgement` only records
 * what the server *dropped* — an id the server ADDED survives into
 * `acknowledgedFilter` unchallenged. Checking that filter by itself therefore
 * let a server deliver a task or resource we never asked about simply by
 * claiming it had honored it, which is the exact inverse of the isolation this
 * predicate exists to enforce.
 *
 * Requested-only would be wrong too: the server must not send a type it never
 * agreed to honor. The safe set is the intersection, so an id has to have been
 * both asked for and agreed to.
 *
 * The boolean list-changed kinds stay on the acknowledged filter. They carry no
 * identifier, so there is no cross-surface state to leak — the worst case is a
 * redundant list refetch.
 */
function filterAllows(
  acknowledged: SubscriptionFilterShape,
  requested: SubscriptionFilterShape,
  kind: SubscriptionNotificationKind,
  uri?: string,
  taskId?: string
): boolean {
  switch (kind) {
    case "tools-list-changed":
      return Boolean(acknowledged.toolsListChanged);
    case "prompts-list-changed":
      return Boolean(acknowledged.promptsListChanged);
    case "resources-list-changed":
      return Boolean(acknowledged.resourcesListChanged);
    case "resource-updated": {
      // A server may legitimately stamp an update for a URI whose exact form
      // differs only by template expansion; MCPJam does not guess — the URI
      // must be one we asked for AND one the server agreed to.
      return (
        uri !== undefined &&
        (acknowledged.resourceSubscriptions ?? []).includes(uri) &&
        (requested.resourceSubscriptions ?? []).includes(uri)
      );
    }
    case "tasks": {
      // Same rule as resources, and it matters more here: task ids are
      // bearer-like handles, so accepting an unrequested one lets a server push
      // state for a task belonging to another surface.
      return (
        taskId !== undefined &&
        (acknowledged.taskIds ?? []).includes(taskId) &&
        (requested.taskIds ?? []).includes(taskId)
      );
    }
  }
}

/**
 * Splits desired interests into the filter we will actually request and the
 * selections the server does not advertise (shown as rejected, not dropped).
 *
 * `era` is required for `taskIds` and for nothing else. The extension
 * capability is a plain capability read with no era in it, so on 2025-11-25 a
 * server that advertises `io.modelcontextprotocol/tasks` still reads as
 * declaring it — while SEP-2663 says that on that revision the extension MUST
 * be treated as absent. Omitting `era` therefore means "not a modern
 * connection" and drops `taskIds`: the legacy wire must never carry an
 * extension-only filter member, and defaulting the other way would put one
 * there for every caller that has not been updated.
 */
export function resolveRequestedFilter(
  desired: DesiredSubscriptionInterests,
  capabilities: ServerCapabilities | undefined,
  era?: "legacy" | "modern"
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

  const wantedTaskIds = [...new Set(desired.taskIds ?? [])];
  if (wantedTaskIds.length > 0) {
    // Gated on the tasks EXTENSION capability, not on any `notifications`
    // sub-flag: SEP-2663 has no per-operation capability flags, so declaring
    // the extension declares the whole method set — including this channel.
    // `serverDeclaresTasksExtension` is the one place allowed to READ that
    // capability, but it is a pure capability read: the "treat the extension as
    // absent on 2025-11-25" rule is the `era` term next to it, not something
    // the predicate knows.
    if (era === "modern" && serverDeclaresTasksExtension(capabilities)) {
      requested.taskIds = wantedTaskIds;
    } else {
      for (const taskId of wantedTaskIds) {
        rejected.push({
          interest: "tasks",
          taskId,
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
  // An unacknowledged task ID is precisely the case the polling fallback
  // exists for: the handle is still ours and still pollable, we just will not
  // be told about it. Recording it keeps that visible instead of leaving the
  // caller to assume a stream it never got.
  const ackedTasks = new Set(acknowledged.taskIds ?? []);
  for (const taskId of requested.taskIds ?? []) {
    if (!ackedTasks.has(taskId)) {
      rejected.push({
        interest: "tasks",
        taskId,
        reason: "not-acknowledged-by-server",
      });
    }
  }
  return rejected;
}

/**
 * How many stream records a coordinator keeps.
 *
 * The history exists for the debugger, so it has to be long enough to show a
 * reconnect sequence and the failures around it — but it cannot be unbounded.
 * Task interest is revised as handles are created and reach terminal states,
 * and every revision either opens a stream or records an unopened one, so on a
 * long-lived connection this map grows with the SESSION rather than with
 * anything the user can see. The oldest terminal records are the ones nobody
 * is reading.
 */
const MAX_RETAINED_STREAMS = 50;

/**
 * How many rejected notifications a coordinator keeps.
 *
 * Unlike the stream history, this one grows on input the PEER controls: a
 * server that keeps sending notifications for a stream that is no longer
 * active, or for a subscription id we never issued, adds a record per
 * notification and nothing ever removed one. The records are small — three to
 * five scalars each, no `params` — so this was slow rather than dramatic, but
 * it had no ceiling at all, and the process it grows in is the Electron main
 * process.
 *
 * Higher than {@link MAX_RETAINED_STREAMS} because rejections arrive in bursts
 * and the debugger wants the burst, not a sample of it.
 */
const MAX_RETAINED_REJECTIONS = 200;

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
  /**
   * Local id → record. Insertion-ordered; closed records are retained up to
   * {@link MAX_RETAINED_STREAMS}.
   */
  private readonly streams = new Map<string, SubscriptionStreamRecord>();
  /** Local id → live handle (modern only). */
  private readonly handles = new Map<string, McpSubscriptionHandle>();
  /** MCP subscription id → local id. */
  private readonly idIndex = new Map<string, string>();
  /** Local id of the currently intended stream, if any. */
  private currentLocalId?: string;
  /** Serializes reconcile/close/reopen so filter churn cannot interleave. */
  private queue: Promise<void> = Promise.resolve();
  /** Bounded by {@link MAX_RETAINED_REJECTIONS}; oldest evicted on write. */
  private readonly rejections: RejectedSubscriptionNotification[] = [];
  /** Legacy adapter bookkeeping: URIs currently `resources/subscribe`d. */
  private legacySubscribedUris = new Set<string>();
  /** Signature of the last all-rejected interest set recorded, for dedupe. */
  private lastUnopenedSignature?: string;

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
      // Copied for the same reason as `resourceUris`, and more urgently: the
      // docs tell callers to drop terminal ids from this list, so a caller
      // mutating the array it got back would silently change the desired
      // filter with no reconcile — and `filtersEqual` would then compare the
      // mutated array against itself and report "unchanged", leaving the live
      // stream watching the wrong set.
      ...(this.desired.taskIds ? { taskIds: [...this.desired.taskIds] } : {}),
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
      ...(desired.resourceUris
        ? { resourceUris: [...desired.resourceUris] }
        : {}),
      ...(desired.taskIds ? { taskIds: [...desired.taskIds] } : {}),
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
      (notification.params?.notifications as SubscriptionFilterShape) ?? {};
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
    // `notifications/tasks` carries a full `DetailedTask`, so the task id is a
    // top-level member of the params rather than a nested envelope field.
    const taskId =
      typeof notification.params?.taskId === "string"
        ? (notification.params.taskId as string)
        : undefined;
    // Enforce against BOTH: the server must not send a type it did not agree to
    // honor, and must not deliver an identifier we never asked about even if it
    // claims to have honored one.
    const acknowledged = stream.acknowledgedFilter ?? stream.requestedFilter;
    if (
      !filterAllows(acknowledged, stream.requestedFilter, kind, uri, taskId)
    ) {
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
      ...(taskId ? { taskId } : {}),
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
    // Oldest first, matching the stream history: a long-lived connection being
    // spammed by its peer should keep the RECENT rejections, which are the ones
    // describing whatever is wrong now.
    if (this.rejections.length > MAX_RETAINED_REJECTIONS) {
      this.rejections.splice(
        0,
        this.rejections.length - MAX_RETAINED_REJECTIONS
      );
    }
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
    const resolved = this.resolveFilter();
    if (this.era === "legacy") {
      await this.reconcileLegacy(resolved.requested, resolved.rejected);
      return;
    }
    await this.reconcileModern(resolved.requested, resolved.rejected);
  }

  /**
   * `resolveRequestedFilter` plus the tasks-declaration gate.
   *
   * Kept together so every caller — reconcile and re-listen alike — sees the
   * same filter. A re-listen that skipped the gate would resurrect a `taskIds`
   * selection this connection cannot declare and earn a `-32021` on reconnect.
   */
  private resolveFilter(): {
    requested: SubscriptionFilterShape;
    rejected: SubscriptionInterestRejection[];
  } {
    const { requested, rejected } = resolveRequestedFilter(
      this.desired,
      this.client.getServerCapabilities(),
      this.era
    );
    const wantedTaskIds = requested.taskIds ?? [];
    if (wantedTaskIds.length === 0) return { requested, rejected };

    if (typeof this.client.listenWithTasksDeclaration === "function") {
      return { requested, rejected };
    }

    // Drop rather than downgrade: an undeclared task-filtered listen is a
    // guaranteed -32021, and the polling fallback loses nothing but latency.
    //
    // Only ONE reason is reachable here. `resolveRequestedFilter` was given the
    // era, so a legacy connection already had its `taskIds` rejected as
    // `capability-not-advertised` — whatever the server advertised, because on
    // 2025-11-25 the extension MUST be treated as absent. So a non-empty
    // `taskIds` at this point means a modern connection, and the only thing
    // still missing is the declaration seam.
    const { taskIds: _dropped, ...withoutTasks } = requested;
    return {
      requested: withoutTasks,
      rejected: [
        ...rejected,
        ...wantedTaskIds.map(
          (taskId): SubscriptionInterestRejection => ({
            interest: "tasks",
            taskId,
            reason: "tasks-declaration-unavailable",
          })
        ),
      ],
    };
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
      if (
        current &&
        (current.status === "active" || current.status === "opening")
      ) {
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
    this.pruneStreams();
    this.currentLocalId = stream.localId;
    this.emitStream(stream);
  }

  /**
   * Trims the retained stream history to {@link MAX_RETAINED_STREAMS}, oldest
   * first.
   *
   * Only records nothing else still points at are eligible: the intended
   * stream, anything holding a live handle, and anything not yet closed stay
   * regardless of age, because dropping one of those would strand the handle
   * and break `resolveStream`'s id binding. In practice the eviction set is
   * exactly the old terminal records — closed streams and the synthetic
   * never-opened ones — which is what actually accumulates.
   */
  private pruneStreams(): void {
    if (this.streams.size <= MAX_RETAINED_STREAMS) return;
    for (const [localId, stream] of this.streams) {
      if (this.streams.size <= MAX_RETAINED_STREAMS) return;
      if (localId === this.currentLocalId) continue;
      if (this.handles.has(localId)) continue;
      if (stream.status === "opening" || stream.status === "active") continue;
      this.streams.delete(localId);
      // The id index outlives nothing: a subscription id that maps to a record
      // we no longer hold would make `resolveStream` return `undefined` for a
      // KNOWN id instead of falling through to the unbound-stream adoption.
      if (stream.mcpSubscriptionId !== undefined) {
        this.idIndex.delete(stream.mcpSubscriptionId);
      }
    }
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
      current && (current.status === "opening" || current.status === "active")
        ? current
        : undefined;

    if (this.disposed || isEmptyFilter(requested)) {
      if (live) await this.closeStream(live, "local-abort", "cancelled");
      this.currentLocalId = undefined;
      // A filter that is empty ONLY because task ids were dropped is not the
      // same as wanting nothing. Without a record here, the reason we fell
      // back to polling would vanish and the caller would have no way to
      // explain why notifications never arrived.
      if (!this.disposed && rejected.length > 0) {
        this.recordUnopenedStream(rejected);
      }

      return;
    }

    if (live && filtersEqual(live.requestedFilter, requested)) {
      return;
    }
    // A listen filter is immutable: change of desire ⇒ controlled close+reopen.
    if (live) await this.closeStream(live, "local-abort", "cancelled");
    await this.openModernStream(requested, rejected, 0);
  }

  /**
   * Records a stream that was never opened, purely so its rejected interests
   * remain visible through `getStreams()`. Terminal on arrival — there is no
   * transport behind it.
   */
  private recordUnopenedStream(
    rejected: SubscriptionInterestRejection[]
  ): void {
    // Deduplicated. A caller that periodically reasserts an interest set which
    // is entirely unavailable would otherwise accumulate one synthetic failure
    // record — and one `onStreamChange` — per reassertion, turning a single
    // steady condition into an ever-growing list of distinct "failures".
    const signature = JSON.stringify(
      [...rejected]
        .map(
          (r) => `${r.interest}|${r.uri ?? ""}|${r.taskId ?? ""}|${r.reason}`
        )
        .sort()
    );
    if (this.lastUnopenedSignature === signature) return;
    this.lastUnopenedSignature = signature;

    const at = this.now();
    const stream: SubscriptionStreamRecord = {
      localId: `${this.instanceId}-unopened-${++this.streamSeq}`,
      era: "modern",
      requestedFilter: {},
      rejectedInterests: [...rejected],
      status: "error",
      closeReason: "error",
      error:
        "No subscription was opened: every requested interest was rejected.",
      openedAt: at,
      closedAt: at,
      reconnectAttempt: 0,
    };
    this.streams.set(stream.localId, stream);
    this.pruneStreams();
    this.emitStream(stream);
  }

  private async openModernStream(
    requested: SubscriptionFilterShape,
    rejected: SubscriptionInterestRejection[],
    reconnectAttempt: number
  ): Promise<void> {
    // A filter carrying `taskIds` MUST go out declared. `resolveFilter` has
    // already dropped `taskIds` when no declared opener exists, so reaching
    // here with them means the opener is present.
    const listen =
      (requested.taskIds?.length ?? 0) > 0
        ? this.client.listenWithTasksDeclaration?.bind(this.client)
        : this.client.listen?.bind(this.client);
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
    this.pruneStreams();
    this.currentLocalId = stream.localId;
    // A real open clears the memo, so if the interest set later becomes
    // entirely unavailable again that IS recorded rather than suppressed.
    this.lastUnopenedSignature = undefined;
    this.emitStream(stream);

    if (!listen) {
      stream.status = "error";
      stream.closeReason = "error";
      stream.error =
        (requested.taskIds?.length ?? 0) > 0
          ? "The connected client cannot open a task-filtered subscriptions/listen " +
            "with the io.modelcontextprotocol/tasks declaration; task state will be polled."
          : "The connected client does not implement subscriptions/listen.";
      stream.closedAt = this.now();
      this.emitStream(stream);
      return;
    }

    this.ensureHandlers();

    let handle: McpSubscriptionHandle;
    try {
      handle = await listen(cloneFilter(requested));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stream.closedAt = this.now();
      stream.error = message;
      if (reconnectAttempt > 0) {
        // A re-listen whose open fails is still the SAME unexpected remote
        // loss, not a new kind of failure: a server that is still down when
        // the backoff expires is precisely what the attempt budget is for.
        // Ending the sequence on the first failed re-open would spend one
        // attempt and report `error`, hiding the loss the user is chasing.
        stream.status = "remote-closed";
        stream.closeReason = "remote";
        this.emitStream(stream);
        if (this.currentLocalId === stream.localId) {
          void this.enqueue(() => this.scheduleRelisten(stream));
        }
        return;
      }
      stream.status = "error";
      stream.closeReason = "error";
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
    const { requested, rejected } = this.resolveFilter();
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
