/**
 * Wire shapes for the LOCAL subscription bridge (MCP 2026-07-28 §13.2).
 *
 * The upstream subscription is owned by the LOCAL `MCPClientManager` (through
 * the SDK's `SubscriptionCoordinator`); the browser only *observes* it. These
 * are the observation shapes carried over `/api/mcp/subscriptions/stream`,
 * declared structurally here rather than re-exported from the SDK so the
 * client bundle never pulls the coordinator (a Node-side object) in for types.
 *
 * Every field the debugger needs to answer "what did the server actually agree
 * to send, on which subscription, and why did it stop" is on the wire:
 * requested vs acknowledged filter (separate facts, never merged), the MCP
 * subscription id and how it was bound, the lifecycle status, and the close
 * reason. Refusals travel too — an unrequested notification type is *shown as
 * rejected*, never silently dropped.
 */

export type SubscriptionEra = "legacy" | "modern";

export type SubscriptionStreamStatusView =
  | "opening"
  | "active"
  | "graceful-closed"
  | "remote-closed"
  | "cancelled"
  | "error";

export type SubscriptionCloseReasonView =
  | "graceful"
  | "remote"
  | "local-abort"
  | "error";

export type SubscriptionInterestKindView =
  | "tools-list-changed"
  | "prompts-list-changed"
  | "resources-list-changed"
  | "resource-updated"
  /** `notifications/tasks` (SEP-2663 extension; modern era only). */
  | "tasks";

export interface SubscriptionFilterView {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  /** Task ids watched for `notifications/tasks` (extension wire only). */
  taskIds?: string[];
}

export interface SubscriptionInterestRejectionView {
  interest: SubscriptionInterestKindView;
  uri?: string;
  /** Present for `tasks` rejections. */
  taskId?: string;
  reason:
    | "capability-not-advertised"
    | "not-acknowledged-by-server"
    /**
     * A task-filtered listen was wanted but this connection cannot put the
     * extension's per-request eligibility declaration on the listen request
     * (sending it undeclared would earn `-32021`). Polling continues — a
     * notification is only ever a poll-now hint, so the handle is not lost.
     */
    | "tasks-declaration-unavailable";
}

export interface SubscriptionStreamView {
  localId: string;
  era: SubscriptionEra;
  mcpSubscriptionId?: string;
  idBinding?: "reported" | "observed";
  requestedFilter: SubscriptionFilterView;
  acknowledgedFilter?: SubscriptionFilterView;
  rejectedInterests: SubscriptionInterestRejectionView[];
  status: SubscriptionStreamStatusView;
  closeReason?: SubscriptionCloseReasonView;
  error?: string;
  openedAt: number;
  acknowledgedAt?: number;
  closedAt?: number;
  reconnectAttempt: number;
}

export interface SubscriptionDesiredInterestsView {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceUris?: string[];
  /**
   * Task ids to watch for `notifications/tasks`. Extension wire only; the
   * Tasks tab owns this member (tracked ∧ not dismissed ∧ not terminal) while
   * the Subscriptions panel owns the rest — writers merge, never replace.
   */
  taskIds?: string[];
}

export interface SubscriptionNotificationView {
  method: string;
  kind: SubscriptionInterestKindView;
  uri?: string;
  /** Task id for `tasks` notifications — the poll-now hint's target. */
  taskId?: string;
  subscriptionId?: string;
  localSubscriptionId: string;
  at: number;
}

export interface SubscriptionRejectedNotificationView {
  method: string;
  subscriptionId?: string;
  localSubscriptionId?: string;
  reason:
    | "unrequested-type"
    | "unknown-subscription-id"
    | "stream-not-active"
    | "request-scoped-notification";
  at: number;
}

/** Everything the browser needs to render one connected server's state. */
export interface SubscriptionServerStateView {
  serverId: string;
  era: SubscriptionEra;
  /** Whether the connection can open a modern `subscriptions/listen` stream. */
  supportsListen: boolean;
  /**
   * Whether a task-filtered listen can go out DECLARED (extension tasks wire ∧
   * listen ∧ the declaration seam). When false, posting `taskIds` records a
   * `tasks-declaration-unavailable` rejection and polling stays the only
   * channel — which is always sufficient.
   */
  supportsTaskDeclaredListen: boolean;
  desired: SubscriptionDesiredInterestsView;
  streams: SubscriptionStreamView[];
  notifications: SubscriptionNotificationView[];
  rejectedNotifications: SubscriptionRejectedNotificationView[];
}

export type SubscriptionBridgeEvent =
  /** Full state for every server the bridge is tracking; sent on connect. */
  | { type: "subscriptions_snapshot"; servers: SubscriptionServerStateView[] }
  /** A stream opened, was acknowledged, reconnected, or closed. */
  | {
      type: "subscription_stream";
      serverId: string;
      era: SubscriptionEra;
      stream: SubscriptionStreamView;
    }
  | {
      type: "subscription_notification";
      serverId: string;
      notification: SubscriptionNotificationView;
    }
  | {
      type: "subscription_rejected";
      serverId: string;
      rejection: SubscriptionRejectedNotificationView;
    };

/** How many per-server events the bridge retains for the History view. */
export const SUBSCRIPTION_BRIDGE_EVENT_LIMIT = 200;
