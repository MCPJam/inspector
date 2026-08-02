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
    typeof message === "string" &&
    message.startsWith("Automatic resolved to ")
  );
}

interface TrafficLogState {
  items: UiLogEvent[];
  mcpServerItems: McpServerRpcItem[];
  addLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
  addMcpServerLog: (item: Omit<McpServerRpcItem, "id"> & { id?: string }) => void;
  clear: () => void;
}

const MAX_ITEMS = 1000;

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
    set((state) => ({
      mcpServerItems: state.mcpServerItems.some(
        (existing) => existing.id === newItem.id,
      )
        ? state.mcpServerItems.map((existing) =>
            existing.id === newItem.id ? newItem : existing,
          )
        : [newItem, ...state.mcpServerItems].slice(0, MAX_ITEMS),
    }));
  },
  clear: () => set({ items: [], mcpServerItems: [] }),
}));

export function ingestHostedRpcLogs(logs: HostedRpcLogEvent[]): void {
  if (!Array.isArray(logs) || logs.length === 0) {
    return;
  }

  const store = useTrafficLogStore.getState();
  logs.forEach((log) => {
    store.addMcpServerLog({
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
    store.addMcpServerLog({
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
    const timestamp = new Date(step.completedAt ?? step.startedAt).toISOString();

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
        httpHistory: trace.httpHistory.filter((entry) => entry.step === step.step),
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
          id?: string;
          serverId?: string;
          direction?: string;
          message?: unknown;
          timestamp?: string;
          exchange?: HttpExchangeLogEvent;
        };
        if (!data) return;

        // The bus-assigned event id. Carrying it into the store turns
        // `addMcpServerLog` into an idempotent keyed upsert for this channel:
        // the stream seeds every new connection with the tail of the replay
        // buffer (`?replay=N`), so a panel remount / EventSource reconnect
        // re-delivers events the store already holds. One id per PHYSICAL
        // published event, so retries and multi-round MRTR flows — distinct
        // frames that merely share a method — still get their own rows.
        const eventId =
          typeof data.id === "string" && data.id.length > 0
            ? data.id
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
        useTrafficLogStore.getState().addMcpServerLog({
          ...(eventId ? { id: eventId } : {}),
          serverId: typeof serverId === "string" ? serverId : "unknown",
          direction:
            typeof direction === "string" ? direction.toUpperCase() : "",
          method: extractMethod(message),
          timestamp: timestamp ?? new Date().toISOString(),
          payload: message,
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
