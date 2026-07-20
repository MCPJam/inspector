import { LoggerView } from "./logger-view";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import {
  buildTracingSnapshot,
  type TraceLogEntryView,
} from "@/lib/webmcp/review-surface-snapshots";

export function TracingTab() {
  // Agent bridge: SNAPSHOT-ONLY (no tools). Tracing is a read-only review
  // screen, so it stays agentTools kind "none" but lets the agent OBSERVE the
  // recent traffic. `TracingTab` is a thin wrapper over `LoggerView` (a SHARED
  // component embedded elsewhere with `serverIds`/`sinceTimestamp`), so the
  // provider reads the traffic-log store directly rather than lifting state
  // into — or bridging from — that shared child. Redacted STATE only: entry
  // counts and recent entries by shape (method/direction/server/time), NEVER
  // the request/response payloads. `hostedBlocked`, so this only registers in
  // local deployments where the screen mounts — which is fine.
  useSurfaceAgentBridge({
    surfaceId: "tracing",
    snapshot: () => {
      const state = useTrafficLogStore.getState();
      const serverItems: TraceLogEntryView[] = state.mcpServerItems.map(
        (item) => ({
          source: item.kind === "oauth" ? "oauth" : "mcp-server",
          method: item.method,
          direction: item.direction,
          serverId: item.serverId,
          serverName: item.serverName,
          timestamp: item.timestamp,
        }),
      );
      const appItems: TraceLogEntryView[] = state.items.map((item) => ({
        source: "mcp-apps",
        method: item.method,
        direction: item.direction === "ui-to-host" ? "UI→HOST" : "HOST→UI",
        serverId: item.serverId,
        serverName: item.serverName,
        timestamp: item.timestamp,
      }));
      return buildTracingSnapshot({ serverItems, appItems });
    },
  });

  return (
    <div className="flex flex-col h-full">
      <LoggerView />
    </div>
  );
}
