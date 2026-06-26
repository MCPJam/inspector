import { useEffect, useMemo, useState } from "react";
import type { ServerWithName } from "@/state/app-types";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { evaluateAllHosts, type HostCompatEvaluation } from "./engine";
import { useWidgetUsage } from "./use-widget-usage";

const TOOLS_FETCH_MAX_ATTEMPTS = 3;

/**
 * Fetch a connected server's tools (+ metadata) for surfaces that don't
 * already hold the list — the server card strip and the standalone
 * Compatibility page. A transient `listTools` failure is retried with linear
 * backoff so the surface doesn't get stuck on "unknown" widgets; only after
 * every attempt fails does the widget dimension stay unknown (the engine
 * reports that gap honestly). Returns `null` until the first fetch resolves,
 * and for a disconnected/absent server.
 */
export function useServerToolsData(
  server: ServerWithName | null,
): ListToolsResultWithMetadata | null {
  const isConnected = server?.connectionStatus === "connected";
  const serverName = server?.name;
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Clear any prior server's tools up front so a disconnect or a rename
    // (server.name change) never evaluates widgets against stale metadata
    // while the new fetch is in flight.
    setToolsData(null);
    if (!isConnected || !serverName) {
      return;
    }

    const attempt = (tries: number) => {
      listTools({ serverId: serverName })
        .then((result) => {
          if (!cancelled) setToolsData(result);
        })
        .catch(() => {
          if (cancelled) return;
          if (tries + 1 < TOOLS_FETCH_MAX_ATTEMPTS) {
            // Linear backoff: 1s, 2s. Widget findings stay unknown only
            // after every attempt has failed.
            retryTimer = setTimeout(() => attempt(tries + 1), 1000 * (tries + 1));
          }
        });
    };
    attempt(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isConnected, serverName]);

  return toolsData;
}

/**
 * Compat reports for one server, for surfaces that don't already hold a
 * tools list (the server card strip). Surfaces that already fetched tools
 * (the detail modal) should call `evaluateAllHosts` directly instead.
 */
export function useHostCompatReports(
  server: ServerWithName,
): HostCompatEvaluation {
  const toolsData = useServerToolsData(server);
  const widgetUsage = useWidgetUsage(server.name, toolsData);

  const protocolVersion = server.initializationInfo?.protocolVersion;
  return useMemo(
    () => evaluateAllHosts(toolsData, widgetUsage, { protocolVersion }),
    [toolsData, widgetUsage, protocolVersion],
  );
}
