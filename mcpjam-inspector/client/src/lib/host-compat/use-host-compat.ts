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
 * Compat reports for one server, for surfaces that don't already hold a
 * tools list (the server card strip). Fetches tools per connection so the
 * widget findings can be derived. Surfaces that already fetched tools (the
 * detail modal) should call `evaluateAllHosts` directly instead.
 *
 * A transient `listTools` failure is retried with backoff so the strip
 * doesn't get stuck advertising "unknown" widgets while the detail modal's
 * own fetch succeeds. Only after the retries are exhausted does the widget
 * dimension stay unknown (the engine reports that gap honestly).
 */
export function useHostCompatReports(
  server: ServerWithName,
): HostCompatEvaluation {
  const isConnected = server.connectionStatus === "connected";
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Clear any prior server's tools up front so a disconnect or a rename
    // (server.name change) never evaluates widgets against stale metadata
    // while the new fetch is in flight.
    setToolsData(null);
    if (!isConnected) {
      return;
    }

    const attempt = (tries: number) => {
      listTools({ serverId: server.name })
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
  }, [isConnected, server.name]);

  const widgetUsage = useWidgetUsage(server.name, toolsData);

  const protocolVersion = server.initializationInfo?.protocolVersion;
  return useMemo(
    () => evaluateAllHosts(toolsData, widgetUsage, { protocolVersion }),
    [toolsData, widgetUsage, protocolVersion],
  );
}
