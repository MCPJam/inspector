import { useEffect, useState } from "react";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { readResource } from "@/lib/apis/mcp-resources-api";
import {
  scanWidgetUsage,
  type ReadResourceResult,
  type WidgetUsage,
} from "@mcpjam/sdk/host-compat";

/**
 * L1 widget scan for one server's tools — a thin React wrapper over the shared
 * SDK `scanWidgetUsage`. For each widget-bearing tool it reads the widget's
 * HTML via `resources/read` (the browser implementation) and scans it (plus the
 * resource's declared `_meta.ui`) for the host APIs it uses. Returns `undefined`
 * until the scan resolves so the engine can withhold capability findings rather
 * than guess; `{}` means "scanned, nothing notable used".
 *
 * Each widget URI is read once even when several tools share it; every tool
 * pointing at that widget inherits its needs.
 */
export function useWidgetUsage(
  serverName: string,
  toolsData: ListToolsResultWithMetadata | null | undefined,
): WidgetUsage | undefined {
  const [usage, setUsage] = useState<WidgetUsage | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setUsage(undefined);
    if (!toolsData?.tools) return;

    scanWidgetUsage(
      toolsData,
      (uri) => readResource(serverName, uri) as Promise<ReadResourceResult>,
    ).then((result) => {
      if (!cancelled) setUsage(result);
    });

    return () => {
      cancelled = true;
    };
    // toolsData identity changes per fetch; that's the intended re-scan key.
  }, [serverName, toolsData]);

  return usage;
}
