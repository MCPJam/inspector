import { useEffect, useMemo, useState } from "react";
import type { ServerWithName } from "@/state/app-types";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { evaluateAllHosts, type HostCompatEvaluation } from "./engine";
import { useHostCatalog } from "./use-host-catalog";
import { useWidgetUsageState } from "./use-widget-usage";
import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import { useCodexHostEnabled } from "@/hooks/useCodexHostEnabled";
import { filterReportsByFeatureFlags } from "./feature-visibility";

const TOOLS_FETCH_MAX_ATTEMPTS = 3;

export type ToolsDataStatus = "idle" | "loading" | "ready" | "failed";

export type ServerToolsDataState = {
  data: ListToolsResultWithMetadata | null;
  status: ToolsDataStatus;
};

/**
 * Fetch a connected server's tools (+ metadata) for surfaces that don't
 * already hold the list — the server card strip and the standalone
 * Compatibility page. A transient `listTools` failure is retried with linear
 * backoff so the surface doesn't get stuck on "unknown" widgets; only after
 * every attempt fails does the widget dimension stay unknown (the engine
 * reports that gap honestly). The explicit status lets surfaces distinguish
 * an in-flight request from a terminal failure.
 */
export function useServerToolsData(
  server: ServerWithName | null
): ServerToolsDataState {
  const isConnected = server?.connectionStatus === "connected";
  const serverName = server?.name;
  const [state, setState] = useState<ServerToolsDataState>({
    data: null,
    status: "idle",
  });

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Clear any prior server's tools up front so a disconnect or a rename
    // (server.name change) never evaluates widgets against stale metadata
    // while the new fetch is in flight.
    setState({ data: null, status: isConnected ? "loading" : "idle" });
    if (!isConnected || !serverName) {
      return;
    }

    const attempt = (tries: number) => {
      listTools({ serverId: serverName })
        .then((result) => {
          if (!cancelled) setState({ data: result, status: "ready" });
        })
        .catch(() => {
          if (cancelled) return;
          if (tries + 1 < TOOLS_FETCH_MAX_ATTEMPTS) {
            // Linear backoff: 1s, 2s. Widget findings stay unknown only
            // after every attempt has failed.
            retryTimer = setTimeout(
              () => attempt(tries + 1),
              1000 * (tries + 1)
            );
          } else {
            setState({ data: null, status: "failed" });
          }
        });
    };
    attempt(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isConnected, serverName]);

  return state;
}

/**
 * Compat reports for one server, for surfaces that don't already hold a
 * tools list (the server card strip). Surfaces that already fetched tools
 * (the detail modal) should call `evaluateAllHosts` directly instead.
 */
export function useHostCompatReports(
  server: ServerWithName
): HostCompatEvaluation {
  const toolsState = useServerToolsData(server);
  const widgetScan = useWidgetUsageState(server.name, toolsState.data);
  const widgetUsage = widgetScan.usage;
  // Live catalog in the deps: verdicts render immediately from the bundled
  // catalog, then recompute once the live fetch lands.
  const catalogState = useHostCatalog();
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const codexEnabled = useCodexHostEnabled();

  const protocolVersion = server.initializationInfo?.protocolVersion;
  const connectionStatus = server.connectionStatus;
  return useMemo(() => {
    const evaluation = evaluateAllHosts(
      toolsState.data,
      widgetUsage,
      { protocolVersion },
      catalogState?.catalog
    );
    return {
      ...evaluation,
      analysisStatus:
        connectionStatus === "connected" &&
        (toolsState.status === "loading" ||
          widgetScan.status === "idle" ||
          widgetScan.status === "loading")
          ? "analyzing"
          : connectionStatus === "connected" &&
            (toolsState.status === "failed" || widgetScan.status === "failed")
          ? "failed"
          : "ready",
      reports: filterReportsByFeatureFlags(evaluation.reports, {
        claudeCode: claudeCodeEnabled,
        codex: codexEnabled,
      }),
    };
  }, [
    toolsState,
    widgetScan,
    widgetUsage,
    protocolVersion,
    connectionStatus,
    catalogState,
    claudeCodeEnabled,
    codexEnabled,
  ]);
}
