import type {
  SubscriptionBridgeEvent,
  SubscriptionFilterView,
  SubscriptionServerStateView,
  SubscriptionStreamView,
} from "@/shared/subscription-bridge.js";

/**
 * Browser-side projection of the LOCAL subscription bridge.
 *
 * Kept as a pure reducer (no React, no fetch) because the interesting product
 * facts are all *transitions*: a stream that went `active → remote-closed` is a
 * different History entry from one that went `active → graceful-closed`, and
 * "the server never acknowledged `tools/list_changed`" is only visible as a
 * difference between two filters. Both are computed here so the view can stay
 * a dumb renderer and the tests can assert on the facts directly.
 */

export type SubscriptionHistoryKind =
  | "opened"
  | "acknowledged"
  | "reconnected"
  | "closed-graceful"
  | "closed-remote"
  | "cancelled"
  | "error"
  | "notification"
  | "rejected";

export interface SubscriptionHistoryEntry {
  id: string;
  kind: SubscriptionHistoryKind;
  serverId: string;
  localSubscriptionId?: string;
  mcpSubscriptionId?: string;
  /** Human-readable, era-neutral summary; the UI renders it verbatim. */
  detail: string;
  at: number;
}

export interface SubscriptionUiState {
  server?: SubscriptionServerStateView;
  history: SubscriptionHistoryEntry[];
}

export const EMPTY_SUBSCRIPTION_UI_STATE: SubscriptionUiState = {
  history: [],
};

/** Newest-first cap; the bridge retains the authoritative longer log. */
const HISTORY_LIMIT = 100;

let historySeq = 0;

function entry(
  partial: Omit<SubscriptionHistoryEntry, "id">,
): SubscriptionHistoryEntry {
  return { id: `sub-history-${++historySeq}`, ...partial };
}

export function formatFilter(filter?: SubscriptionFilterView): string {
  if (!filter) return "—";
  const parts: string[] = [];
  if (filter.toolsListChanged) parts.push("tools/list_changed");
  if (filter.promptsListChanged) parts.push("prompts/list_changed");
  if (filter.resourcesListChanged) parts.push("resources/list_changed");
  for (const uri of filter.resourceSubscriptions ?? []) parts.push(uri);
  for (const taskId of filter.taskIds ?? []) parts.push(`task:${taskId}`);
  return parts.length ? parts.join(", ") : "(empty)";
}

export const STREAM_STATUS_LABELS: Record<
  SubscriptionStreamView["status"],
  string
> = {
  opening: "Opening (awaiting acknowledgement)",
  active: "Active",
  "graceful-closed": "Closed by server (graceful)",
  "remote-closed": "Connection lost (remote close)",
  cancelled: "Cancelled locally",
  error: "Error",
};

/** Interests the server never acknowledged — shown, never silently dropped. */
export function unacknowledgedInterests(
  stream: SubscriptionStreamView,
): string[] {
  return stream.rejectedInterests.map((rejection) => {
    const what = rejection.uri ?? rejection.taskId ?? rejection.interest;
    switch (rejection.reason) {
      case "capability-not-advertised":
        return `${what} (not advertised)`;
      // The connection cannot put the tasks declaration on the listen, so the
      // task-id selection was dropped rather than sent undeclared (-32021).
      // Polling continues — nothing is lost but latency.
      case "tasks-declaration-unavailable":
        return `${what} (cannot declare tasks extension; polling instead)`;
      default:
        return `${what} (not acknowledged)`;
    }
  });
}

function closeHistoryKind(
  stream: SubscriptionStreamView,
): SubscriptionHistoryKind | undefined {
  switch (stream.status) {
    case "graceful-closed":
      return "closed-graceful";
    case "remote-closed":
      return "closed-remote";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function streamHistory(
  serverId: string,
  previous: SubscriptionStreamView | undefined,
  next: SubscriptionStreamView,
): SubscriptionHistoryEntry[] {
  const out: SubscriptionHistoryEntry[] = [];
  const base = {
    serverId,
    localSubscriptionId: next.localId,
    ...(next.mcpSubscriptionId
      ? { mcpSubscriptionId: next.mcpSubscriptionId }
      : {}),
  };

  if (!previous) {
    out.push(
      entry({
        ...base,
        kind: next.reconnectAttempt > 0 ? "reconnected" : "opened",
        detail:
          next.reconnectAttempt > 0
            ? `Re-listen attempt ${next.reconnectAttempt} requested ${formatFilter(next.requestedFilter)}`
            : `Requested ${formatFilter(next.requestedFilter)}`,
        at: next.openedAt,
      }),
    );
  }

  if (next.acknowledgedFilter && !previous?.acknowledgedFilter) {
    out.push(
      entry({
        ...base,
        kind: "acknowledged",
        detail: `Server acknowledged ${formatFilter(next.acknowledgedFilter)}`,
        at: next.acknowledgedAt ?? next.openedAt,
      }),
    );
  }

  const kind = closeHistoryKind(next);
  if (kind && next.status !== previous?.status) {
    out.push(
      entry({
        ...base,
        kind,
        detail: next.error
          ? `${STREAM_STATUS_LABELS[next.status]}: ${next.error}`
          : STREAM_STATUS_LABELS[next.status],
        at: next.closedAt ?? next.openedAt,
      }),
    );
  }

  return out;
}

function withHistory(
  state: SubscriptionUiState,
  entries: SubscriptionHistoryEntry[],
): SubscriptionHistoryEntry[] {
  if (entries.length === 0) return state.history;
  return [...entries.reverse(), ...state.history].slice(0, HISTORY_LIMIT);
}

/** Replaces the tracked server state (from a snapshot or a REST response). */
export function applyServerState(
  state: SubscriptionUiState,
  server: SubscriptionServerStateView,
): SubscriptionUiState {
  const previous = new Map(
    (state.server?.streams ?? []).map((s) => [s.localId, s]),
  );
  const entries = server.streams.flatMap((stream) =>
    streamHistory(server.serverId, previous.get(stream.localId), stream),
  );
  return { server, history: withHistory(state, entries) };
}

export function applySubscriptionEvent(
  state: SubscriptionUiState,
  serverId: string,
  event: SubscriptionBridgeEvent,
): SubscriptionUiState {
  switch (event.type) {
    case "subscriptions_snapshot": {
      const server = event.servers.find((s) => s.serverId === serverId);
      return server ? applyServerState(state, server) : state;
    }
    case "subscription_stream": {
      if (event.serverId !== serverId) return state;
      const current = state.server ?? {
        serverId,
        era: event.era,
        supportsListen: event.era === "modern",
        // A placeholder built from a stream event alone cannot know the
        // declared-listen probe; false is the safe default until a snapshot
        // or REST response replaces it.
        supportsTaskDeclaredListen: false,
        desired: {},
        streams: [],
        notifications: [],
        rejectedNotifications: [],
      };
      const previous = current.streams.find(
        (s) => s.localId === event.stream.localId,
      );
      const streams = previous
        ? current.streams.map((s) =>
            s.localId === event.stream.localId ? event.stream : s,
          )
        : [...current.streams, event.stream];
      return {
        server: { ...current, era: event.era, streams },
        history: withHistory(
          state,
          streamHistory(serverId, previous, event.stream),
        ),
      };
    }
    case "subscription_notification": {
      if (event.serverId !== serverId || !state.server) return state;
      const n = event.notification;
      return {
        server: {
          ...state.server,
          notifications: [...state.server.notifications, n],
        },
        history: withHistory(state, [
          entry({
            serverId,
            kind: "notification",
            localSubscriptionId: n.localSubscriptionId,
            ...(n.subscriptionId ? { mcpSubscriptionId: n.subscriptionId } : {}),
            detail: n.uri ? `${n.method} (${n.uri})` : n.method,
            at: n.at,
          }),
        ]),
      };
    }
    case "subscription_rejected": {
      if (event.serverId !== serverId || !state.server) return state;
      const r = event.rejection;
      return {
        server: {
          ...state.server,
          rejectedNotifications: [...state.server.rejectedNotifications, r],
        },
        history: withHistory(state, [
          entry({
            serverId,
            kind: "rejected",
            ...(r.localSubscriptionId
              ? { localSubscriptionId: r.localSubscriptionId }
              : {}),
            ...(r.subscriptionId ? { mcpSubscriptionId: r.subscriptionId } : {}),
            detail: `Rejected ${r.method} — ${r.reason}`,
            at: r.at,
          }),
        ]),
      };
    }
  }
}
