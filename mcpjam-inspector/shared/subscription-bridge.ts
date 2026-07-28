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
  | "resource-updated";

export interface SubscriptionFilterView {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

export interface SubscriptionInterestRejectionView {
  interest: SubscriptionInterestKindView;
  uri?: string;
  reason: "capability-not-advertised" | "not-acknowledged-by-server";
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
}

export interface SubscriptionNotificationView {
  method: string;
  kind: SubscriptionInterestKindView;
  uri?: string;
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
