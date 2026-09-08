/**
 * Traffic Log Store - Captures all MCP traffic for debugging
 *
 * Includes:
 * - MCP Apps / OpenAI Apps SDK traffic (iframe ↔ host messages)
 * - MCP Server RPC traffic (client ↔ server messages)
 * - The HTTP exchanges those messages rode in (headers only) — the `Mcp-*`
 *   mirrored headers are wire state the JSON-RPC body cannot show
 *
 * This is a singleton store - no provider required.
 * The SSE subscription is also a singleton to prevent duplicate connections.
 */

import { create } from "zustand";
import { addTokenToUrl } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import type {
  HostedHttpLogEvent,
  HostedRpcLogEvent,
} from "@/shared/hosted-rpc-log";
import type {
  OAuthTrace,
  OAuthTraceSource,
  OAuthTraceStepStatus,
} from "@/lib/oauth/oauth-trace";
// `extractMethod` relocated to the SDK widget-runtime (Phase 3d-ii); imported
// for internal use and re-exported below so existing import sites are unchanged.
import { extractMethod } from "@mcpjam/sdk/widget-runtime";
import type { HttpExchangeLogEvent } from "@mcpjam/sdk/browser";
import {
  measureString,
  probeSerializedSize,
  truncateRpcPayload,
} from "@/shared/rpc-log-truncation";

/**
 * The path of an exchange URL — the row label. The query string is dropped on
 * purpose: this label feeds the Tracing agent snapshot, and a query can carry
 * a token. The full URL stays on the payload, which the snapshot never reads.
 */
function describeHttpTarget(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export type UiProtocol = "mcp-apps" | "openai-apps";
export type McpServerLogKind = "rpc" | "oauth" | "http";

export interface UiLogEvent {
  id: string;
  widgetId: string; // toolCallId
  serverId: string;
  serverName?: string;
  direction: "host-to-ui" | "ui-to-host";
  protocol: UiProtocol;
  method: string;
  timestamp: string;
  message: unknown;
}

export interface McpServerRpcItem {
  id: string;
  serverId: string;
  serverName?: string;
  direction: string;
  method: string;
  timestamp: string;
  payload: unknown;
  kind?: McpServerLogKind;
  oauthStatus?: OAuthTraceStepStatus;
  oauthSource?: OAuthTraceSource;
  oauthRecovered?: boolean;
}

function isAutomaticAuthorizationDecisionMessage(
  message: unknown,
): message is string {
  return (
    typeof message === "string" && message.startsWith("Automatic resolved to ")
  );
}

interface TrafficLogState {
  items: UiLogEvent[];
  mcpServerItems: McpServerRpcItem[];
  addLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
  addMcpServerLog: (
    item: Omit<McpServerRpcItem, "id"> & { id?: string },
  ) => void;
  clear: () => void;
}

const MAX_ITEMS = 1000;

/**
 * Per-row payload retention cap for the LOCAL rpc stream, mirroring
 * `MAX_MESSAGE_BYTES` in `server/services/rpc-log-bus.ts`.
 *
 * `MAX_ITEMS` bounds the row COUNT and nothing else, which does not bound
 * memory: 1000 rows of tool results carrying base64 images is how the renderer
 * reached its own heap ceiling (INSPECTOR-ELECTRON-VJ on /tools and -VT on
 * /playground, both dying in mark-compact, both `deployment: self_hosted`).
 *
 * Scoped to this ingest path rather than to `addMcpServerLog`, because only
 * here is the size cheap: the SSE frame arrives as TEXT the browser already
 * holds, so nothing has to be serialized to measure it — `measureString` walks
 * that text instead, and stops at the cap. That text carries the event envelope
 * as well as the payload, making the cap slightly conservative. Hosted-mode rows
 * arrive from a different producer and are bounded there.
 *
 * MIRRORING IS THE POINT: raising the server cap alone changes nothing that
 * reaches the panel, because whatever survives the bus is cut again here. The
 * two constants have to move together, in both directions.
 */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Total retained payload budget across every row — the browser twin of
 * `MAX_BUFFERED_BYTES_PER_SERVER` in `server/services/rpc-log-bus.ts`, and the
 * cap that actually bounds this store.
 *
 * `MAX_ITEMS` and `MAX_PAYLOAD_BYTES` do not compose into a memory bound. A
 * thousand rows each just under the per-row cap is a gigabyte, and every raise
 * of the per-row cap raises that ceiling with it — the per-row number buys
 * legible rows, not a bounded heap. The renderer has already died of exactly
 * this shape (INSPECTOR-ELECTRON-VJ on /tools, -VT on /playground, both in
 * mark-compact), so the row count is not what is holding it up. This is.
 */
const MAX_RETAINED_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * What each retained row was charged against {@link MAX_RETAINED_PAYLOAD_BYTES}.
 *
 * Keyed on the row OBJECT rather than on its id: rows are replaced wholesale by
 * an upsert and dropped without ceremony by eviction, and a WeakMap needs no
 * bookkeeping for either — the entry goes when the row does. Charging once at
 * insert is what keeps eviction from re-measuring a thousand payloads per frame.
 */
const retainedPayloadBytes = new WeakMap<McpServerRpcItem, number>();

/**
 * Trim to both caps, oldest first. `items` is newest-first, so everything from
 * the cut onwards is the oldest history.
 *
 * The newest row is kept even when it alone is over the budget: a list that
 * evicts itself empty shows a reader nothing at all, which is strictly worse
 * than one oversized row. Same rule, and the same reason, as the bus.
 */
function withinRetentionBudget(items: McpServerRpcItem[]): McpServerRpcItem[] {
  const capped = items.length > MAX_ITEMS ? items.slice(0, MAX_ITEMS) : items;
  let bytes = 0;
  for (let i = 0; i < capped.length; i++) {
    bytes += retainedPayloadBytes.get(capped[i]) ?? 0;
    if (bytes > MAX_RETAINED_PAYLOAD_BYTES && i > 0) {
      return capped.slice(0, i);
    }
  }
  return capped;
}

export const useTrafficLogStore = create<TrafficLogState>((set) => ({
  items: [],
  mcpServerItems: [],
  addLog: (event) => {
    const newItem: UiLogEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
    };
    set((state) => ({
      items: [newItem, ...state.items].slice(0, MAX_ITEMS),
    }));
  },
  addMcpServerLog: (item) => {
    const newItem: McpServerRpcItem = {
      ...item,
      id: item.id ?? `${item.timestamp}-${Math.random().toString(36).slice(2)}`,
    };
    // Keyed upsert, LAST WRITE WINS. Two deliveries that share an id are
    // expected to be BYTE-IDENTICAL — today they always are, because every
    // path that can deliver twice (the Logs SSE replay window, a hosted
    // collector streaming an event and then repeating it in the envelope)
    // re-sends the same buffered object. That is an invariant of the
    // producers, not something enforced here: if some future delivery ever
    // enriches an event on the second pass (say the envelope copy carries
    // `pluginOrigin` and the streamed copy did not), the later one silently
    // overwrites the earlier with no signal. Enrich at CAPTURE, or give the
    // enriched event its own id.
    retainedPayloadBytes.set(
      newItem,
      probeSerializedSize(newItem.payload, MAX_RETAINED_PAYLOAD_BYTES).bytes,
    );
    set((state) => ({
      mcpServerItems: withinRetentionBudget(
        state.mcpServerItems.some((existing) => existing.id === newItem.id)
          ? state.mcpServerItems.map((existing) =>
              existing.id === newItem.id ? newItem : existing,
            )
          : [newItem, ...state.mcpServerItems],
      ),
    }));
  },
  clear: () => set({ items: [], mcpServerItems: [] }),
}));

/**
 * The producer-stamped `eventId` of a hosted log event, when it sent one.
 *
 * Feeding it to `addMcpServerLog` as that row's `id` makes hosted ingestion
 * idempotent for the same reason the local SSE path needs it: one captured
 * event can reach the browser twice. A `HostedRpcLogCollector` streams events
 * as `data-rpc-log` / `data-http-log` parts, but a stream write that fails
 * mid-turn drops the writer and falls back to envelope delivery — and the
 * envelope carries the ALREADY-STREAMED events too. Keyed on the producer's
 * `eventId`, the second delivery updates its row instead of appending a copy.
 *
 * `undefined` for a producer that predates the field: those events append,
 * exactly as they always did, so version skew degrades instead of losing rows.
 */
function hostedEventId(log: { eventId?: string }): string | undefined {
  return typeof log.eventId === "string" && log.eventId.length > 0
    ? log.eventId
    : undefined;
}

export function ingestHostedRpcLogs(logs: HostedRpcLogEvent[]): void {
  if (!Array.isArray(logs) || logs.length === 0) {
    return;
  }

  const store = useTrafficLogStore.getState();
  logs.forEach((log) => {
    const id = hostedEventId(log);
    store.addMcpServerLog({
      ...(id ? { id } : {}),
      serverId: log.serverId,
      serverName: log.serverName,
      direction: log.direction.toUpperCase(),
      method: extractMethod(log.message),
      timestamp: log.timestamp,
      payload: log.message,
    });
  });
}

/**
 * Hosted-mode twin of the local SSE path's `kind: "http"` branch.
 *
 * Deliberately builds the SAME `McpServerRpcItem` shape that branch does —
 * `direction: "HTTP"`, a `METHOD /path` label, the exchange as the payload —
 * so the source funnel and `HttpExchangeDetails` need no hosted-specific
 * casing. If the two ever diverge, the Tracing panel silently renders one mode
 * differently from the other; keep them in step.
 */
export function ingestHostedHttpLogs(logs: HostedHttpLogEvent[]): void {
  if (!Array.isArray(logs) || logs.length === 0) {
    return;
  }

  const store = useTrafficLogStore.getState();
  logs.forEach((log) => {
    const id = hostedEventId(log);
    store.addMcpServerLog({
      ...(id ? { id } : {}),
      serverId: log.serverId,
      serverName: log.serverName,
      direction: "HTTP",
      method: `${log.exchange.request.method} ${describeHttpTarget(
        log.exchange.request.url,
      )}`,
      timestamp: log.timestamp,
      payload: log.exchange,
      kind: "http",
    });
  });
}

export function ingestOAuthTraceLogs(input: {
  serverId: string;
  serverName?: string;
  trace: OAuthTrace;
}): void {
  const { serverId, serverName, trace } = input;
  if (!trace || !Array.isArray(trace.steps) || trace.steps.length === 0) {
    return;
  }

  const store = useTrafficLogStore.getState();
  trace.steps.forEach((step) => {
    const timestamp = new Date(
      step.completedAt ?? step.startedAt,
    ).toISOString();

    if (isAutomaticAuthorizationDecisionMessage(step.message)) {
      store.addMcpServerLog({
        id: `oauth:${serverId}:${trace.source}:automatic_resolution:${step.startedAt}`,
        serverId,
        serverName,
        direction: "OAUTH",
        method: "Automatic Resolution",
        timestamp,
        payload: {
          source: trace.source,
          step: "automatic_resolution",
          title: "Automatic Resolution",
          status: step.status,
          message: step.message,
          details: step.details,
          relatedStep: step.step,
        },
        kind: "oauth",
        oauthStatus: step.status,
        oauthSource: trace.source,
        oauthRecovered: step.recovered === true,
      });
    }

    store.addMcpServerLog({
      id: `oauth:${serverId}:${trace.source}:${step.step}:${step.startedAt}`,
      serverId,
      serverName,
      direction: "OAUTH",
      method: step.title,
      timestamp,
      payload: {
        source: trace.source,
        step: step.step,
        title: step.title,
        status: step.status,
        message: step.message,
        error: step.error,
        details: step.details,
        recovered: step.recovered,
        recoveredAt: step.recoveredAt,
        recoveryMessage: step.recoveryMessage,
        httpHistory: trace.httpHistory.filter(
          (entry) => entry.step === step.step,
        ),
      },
      kind: "oauth",
      oauthStatus: step.status,
      oauthSource: trace.source,
      oauthRecovered: step.recovered === true,
    });
  });
}

/**
 * Singleton SSE subscription for MCP server RPC traffic.
 * This ensures only one EventSource connection exists regardless of
 * how many LoggerView components are mounted.
 */
let sseConnection: EventSource | null = null;
let sseSubscriberCount = 0;

export function subscribeToRpcStream(): () => void {
  if (HOSTED_MODE) {
    return () => {};
  }

  sseSubscriberCount++;

  if (!sseConnection) {
    const params = new URLSearchParams();
    params.set("replay", "3");
    params.set("_t", Date.now().toString());

    sseConnection = new EventSource(
      addTokenToUrl(`/api/mcp/servers/rpc/stream?${params.toString()}`),
    );

    sseConnection.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as {
          type?: string;
          eventId?: string;
          serverId?: string;
          direction?: string;
          message?: unknown;
          timestamp?: string;
          exchange?: HttpExchangeLogEvent;
        };
        if (!data) return;

        // The bus-assigned `eventId`, used as this row's store key. That turns
        // `addMcpServerLog` into an idempotent keyed upsert for this channel:
        // the stream seeds every new connection with the tail of the replay
        // buffer (`?replay=N`), so a panel remount / EventSource reconnect
        // re-delivers events the store already holds. One id per PHYSICAL
        // published event, so retries and multi-round MRTR flows — distinct
        // frames that merely share a method — still get their own rows.
        const eventId =
          typeof data.eventId === "string" && data.eventId.length > 0
            ? data.eventId
            : undefined;

        if (data.type === "http") {
          if (!data.exchange) return;
          const exchange = data.exchange;
          useTrafficLogStore.getState().addMcpServerLog({
            ...(eventId ? { id: eventId } : {}),
            serverId:
              typeof data.serverId === "string" ? data.serverId : "unknown",
            direction: "HTTP",
            method: `${exchange.request.method} ${describeHttpTarget(exchange.request.url)}`,
            timestamp: data.timestamp ?? new Date().toISOString(),
            payload: exchange,
            kind: "http",
          });
          return;
        }

        if (data.type !== "rpc") return;

        const { serverId, direction, message, timestamp } = data;
        // `message` stays transient and is collected right after this call;
        // only the marker is retained. The method is still read off the real
        // frame, so an oversized row keeps its label and its place in the list.
        useTrafficLogStore.getState().addMcpServerLog({
          ...(eventId ? { id: eventId } : {}),
          serverId: typeof serverId === "string" ? serverId : "unknown",
          direction:
            typeof direction === "string" ? direction.toUpperCase() : "",
          method: extractMethod(message),
          timestamp: timestamp ?? new Date().toISOString(),
          payload:
            measureString(evt.data, MAX_PAYLOAD_BYTES).utf8 > MAX_PAYLOAD_BYTES
              ? truncateRpcPayload(message, MAX_PAYLOAD_BYTES)
              : message,
        });
      } catch {
        // Ignore parse errors
      }
    };

    sseConnection.onerror = () => {
      sseConnection?.close();
      sseConnection = null;
      sseSubscriberCount = 0; // Reset - old subscribers are effectively orphaned
    };
  }

  // Return unsubscribe function
  return () => {
    sseSubscriberCount--;
    if (sseSubscriberCount <= 0 && sseConnection) {
      sseConnection.close();
      sseConnection = null;
      sseSubscriberCount = 0;
    }
  };
}

// `extractMethod` is imported from @mcpjam/sdk/widget-runtime (Phase 3d-ii) and
// re-exported here for back-compat with `@/stores/traffic-log-store` consumers.
export { extractMethod };
