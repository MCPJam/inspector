import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { addTokenToUrl } from "@/lib/session-token";
import {
  cancelSubscriptionStream,
  fetchSubscriptionState,
  setDesiredSubscriptionInterests,
} from "@/lib/apis/mcp-subscriptions-api";
import type {
  SubscriptionBridgeEvent,
  SubscriptionDesiredInterestsView,
  SubscriptionServerStateView,
  SubscriptionStreamView,
} from "@/shared/subscription-bridge.js";
import {
  applyServerState,
  applySubscriptionEvent,
  EMPTY_SUBSCRIPTION_UI_STATE,
  formatFilter,
  STREAM_STATUS_LABELS,
  unacknowledgedInterests,
  type SubscriptionUiState,
} from "./subscription-stream-state";

/**
 * Observation surface for the LOCAL manager's subscription (spec §13.2).
 *
 * The panel is era-branched on the *negotiated* era reported by the bridge:
 *
 * - **modern** — there are no Subscribe/Unsubscribe buttons, because there is
 *   no per-URI verb to press. The user edits the DESIRED FILTER and the
 *   coordinator performs a controlled close + reopen of `subscriptions/listen`
 *   (a listen filter is immutable for the life of a subscription).
 * - **legacy** — the per-URI `resources/subscribe` / `resources/unsubscribe`
 *   buttons are preserved exactly, since that era has no stream to reopen.
 *
 * Both eras render the same stream facts: lifecycle status, the MCP
 * subscription id (and whether it was reported or observed), the requested
 * filter *next to* the acknowledged one, the interests the server refused, and
 * the close reason — graceful and remote closes are distinct entries, never
 * flattened into "disconnected".
 */

type PanelAction =
  | { type: "server-state"; server: SubscriptionServerStateView }
  | { type: "bridge-event"; serverId: string; event: SubscriptionBridgeEvent }
  | { type: "reset" };

function reducer(
  state: SubscriptionUiState,
  action: PanelAction,
): SubscriptionUiState {
  switch (action.type) {
    case "server-state":
      return applyServerState(state, action.server);
    case "bridge-event":
      return applySubscriptionEvent(state, action.serverId, action.event);
    case "reset":
      return EMPTY_SUBSCRIPTION_UI_STATE;
  }
}

export interface SubscriptionStreamsPanelProps {
  serverId: string;
  /** Resource URIs the user can watch (`notifications/resources/updated`). */
  resourceUris?: string[];
  connected?: boolean;
}

export function SubscriptionStreamsPanel({
  serverId,
  resourceUris = [],
  connected = true,
}: SubscriptionStreamsPanelProps) {
  const [state, dispatch] = useReducer(reducer, EMPTY_SUBSCRIPTION_UI_STATE);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dispatch({ type: "reset" });
  }, [serverId]);

  useEffect(() => {
    if (!connected || !serverId) return;
    let cancelled = false;
    fetchSubscriptionState(serverId)
      .then((server) => {
        if (!cancelled) dispatch({ type: "server-state", server });
      })
      .catch(() => {
        // The snapshot is an observation convenience: a server with no
        // coordinator yet (or a surface where the bridge is unavailable) is
        // not a user-facing failure. Only user-driven actions report errors.
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, connected]);

  useEffect(() => {
    if (!connected || !serverId) return;
    // Environments without SSE (jsdom, SSR) still render the snapshot fetched
    // above; only the live lifecycle updates are unavailable there.
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(addTokenToUrl("/api/mcp/subscriptions/stream"));
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as SubscriptionBridgeEvent;
        dispatch({ type: "bridge-event", serverId, event });
      } catch {
        // Malformed frames are ignored; EventSource keeps the channel open.
      }
    };
    return () => es.close();
  }, [serverId, connected]);

  const server = state.server;
  const era = server?.era ?? "legacy";
  const desired: SubscriptionDesiredInterestsView = useMemo(
    () => server?.desired ?? {},
    [server],
  );

  const applyDesired = useCallback(
    async (next: SubscriptionDesiredInterestsView) => {
      setBusy(true);
      setError("");
      try {
        const updated = await setDesiredSubscriptionInterests(serverId, next);
        dispatch({ type: "server-state", server: updated });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [serverId],
  );

  const toggleListChanged = useCallback(
    (
      key: "toolsListChanged" | "promptsListChanged" | "resourcesListChanged",
    ) => {
      void applyDesired({ ...desired, [key]: !desired[key] });
    },
    [applyDesired, desired],
  );

  const toggleUri = useCallback(
    (uri: string) => {
      const current = desired.resourceUris ?? [];
      const next = current.includes(uri)
        ? current.filter((u) => u !== uri)
        : [...current, uri];
      void applyDesired({ ...desired, resourceUris: next });
    },
    [applyDesired, desired],
  );

  const cancelStream = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const updated = await cancelSubscriptionStream(serverId);
      dispatch({ type: "server-state", server: updated });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [serverId]);

  const streams = server?.streams ?? [];
  const watched = new Set(desired.resourceUris ?? []);

  return (
    <div className="flex flex-col gap-3 p-3 text-xs" data-testid="subscriptions-panel">
      <div className="flex items-center gap-2">
        <span className="font-medium">Subscriptions</span>
        <Badge variant="secondary" data-testid="subscription-era">
          {era === "modern" ? "subscriptions/listen" : "resources/subscribe"}
        </Badge>
        {/* Observation only: the Tasks tab owns the `taskIds` interest. When
            absent, task state is polled — which is always sufficient. */}
        {server?.supportsTaskDeclaredListen && (
          <Badge variant="outline" data-testid="task-notifications-supported">
            task notifications
          </Badge>
        )}
        {busy && <span className="text-muted-foreground">Updating…</span>}
      </div>

      {error && (
        <div className="text-destructive" role="alert">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1" data-testid="desired-filter">
        <span className="text-muted-foreground">Desired filter</span>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["toolsListChanged", "tools/list_changed"],
              ["promptsListChanged", "prompts/list_changed"],
              ["resourcesListChanged", "resources/list_changed"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={label}
                checked={Boolean(desired[key])}
                disabled={busy || !connected}
                onChange={() => toggleListChanged(key)}
              />
              {label}
            </label>
          ))}
        </div>
        {era === "modern" && (
          <span className="text-muted-foreground">
            Changing the desired filter closes the current stream and opens a
            new one.
          </span>
        )}
      </div>

      {resourceUris.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="resource-interests">
          <span className="text-muted-foreground">Resource updates</span>
          {resourceUris.map((uri) =>
            era === "modern" ? (
              <label key={uri} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  aria-label={`Watch ${uri}`}
                  checked={watched.has(uri)}
                  disabled={busy || !connected}
                  onChange={() => toggleUri(uri)}
                />
                <span className="font-mono">{uri}</span>
              </label>
            ) : (
              // LEGACY era: the per-URI RPCs are the only mechanism, so the
              // original Subscribe / Unsubscribe buttons stay exactly as they
              // are. The coordinator's legacy adapter issues
              // `resources/subscribe` / `resources/unsubscribe`.
              <div key={uri} className="flex items-center gap-2">
                <span className="font-mono flex-1 truncate">{uri}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => toggleUri(uri)}
                >
                  {watched.has(uri) ? "Unsubscribe" : "Subscribe"}
                </Button>
              </div>
            ),
          )}
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="subscription-streams">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Streams</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !connected || streams.length === 0}
            onClick={() => void cancelStream()}
          >
            Cancel stream
          </Button>
        </div>
        {streams.length === 0 && (
          <span className="text-muted-foreground">No stream opened yet.</span>
        )}
        {streams.map((stream) => (
          <StreamRow key={stream.localId} stream={stream} />
        ))}
      </div>

      <div className="flex flex-col gap-1" data-testid="subscription-history">
        <span className="text-muted-foreground">History</span>
        {state.history.length === 0 && (
          <span className="text-muted-foreground">No activity yet.</span>
        )}
        <ul className="flex flex-col gap-0.5">
          {state.history.map((item) => (
            <li key={item.id} data-testid={`history-${item.kind}`}>
              <span className="font-mono">{item.kind}</span> — {item.detail}
              {item.localSubscriptionId
                ? ` [${item.localSubscriptionId}]`
                : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StreamRow({ stream }: { stream: SubscriptionStreamView }) {
  const unacknowledged = unacknowledgedInterests(stream);
  return (
    <div
      className="rounded border border-border p-2 flex flex-col gap-0.5"
      data-testid={`stream-${stream.localId}`}
    >
      <div className="flex items-center gap-2">
        <Badge variant="outline">{STREAM_STATUS_LABELS[stream.status]}</Badge>
        <span className="font-mono truncate">{stream.localId}</span>
      </div>
      <div>
        Subscription id:{" "}
        <span className="font-mono">{stream.mcpSubscriptionId ?? "—"}</span>
        {stream.idBinding ? ` (${stream.idBinding})` : ""}
      </div>
      <div>Requested: {formatFilter(stream.requestedFilter)}</div>
      <div>Acknowledged: {formatFilter(stream.acknowledgedFilter)}</div>
      {unacknowledged.length > 0 && (
        <div className="text-destructive">
          Not honored: {unacknowledged.join(", ")}
        </div>
      )}
      {stream.closeReason && <div>Close reason: {stream.closeReason}</div>}
      {stream.error && <div className="text-destructive">{stream.error}</div>}
      {stream.reconnectAttempt > 0 && (
        <div>Re-listen attempt: {stream.reconnectAttempt}</div>
      )}
    </div>
  );
}
