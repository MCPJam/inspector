import { useEffect, useMemo, useState } from "react";
import type { ServerWithName } from "@/state/app-types";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { evaluateAllHosts, type HostCompatEvaluation } from "./engine";

/**
 * Compat reports for one server, for surfaces that don't already hold a
 * tools list (the server card strip). Fetches tools once per connection so
 * widget findings can be derived; transport/auth/capability findings work
 * without it. Surfaces that already fetched tools (the detail modal) should
 * call `evaluateAllHosts` directly instead.
 */
export function useHostCompatReports(
  server: ServerWithName,
): HostCompatEvaluation {
  const isConnected = server.connectionStatus === "connected";
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isConnected) {
      setToolsData(null);
      return;
    }
    listTools({ serverId: server.name })
      .then((result) => {
        if (!cancelled) setToolsData(result);
      })
      .catch(() => {
        // Widget findings simply stay unknown; the engine reports the gap.
        if (!cancelled) setToolsData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, server.name]);

  return useMemo(
    () => evaluateAllHosts(server, toolsData),
    [server, toolsData],
  );
}
