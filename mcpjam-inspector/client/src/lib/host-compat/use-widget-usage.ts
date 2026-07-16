import { useEffect, useState } from "react";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { readResource } from "@/lib/apis/mcp-resources-api";
import {
  scanWidgetUsage,
  type ReadResourceResult,
  type WidgetUsage,
} from "@mcpjam/sdk/host-compat";

export type WidgetUsageScanState =
  | { status: "idle"; usage: undefined }
  | { status: "loading"; usage: undefined }
  | { status: "ready"; usage: WidgetUsage }
  | { status: "failed"; usage: undefined };

/**
 * The inspector resource endpoint wraps MCP's `resources/read` result in a
 * `content` field, while the shared scanner consumes the MCP result itself.
 * Keep that transport detail at this adapter boundary so existing resource
 * browser consumers can continue receiving the endpoint response unchanged.
 */
export function normalizeWidgetResourceReadResult(
  result: unknown
): ReadResourceResult {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    result.content &&
    typeof result.content === "object"
  ) {
    return result.content as ReadResourceResult;
  }
  return (result ?? {}) as ReadResourceResult;
}

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
export function useWidgetUsageState(
  serverName: string,
  toolsData: ListToolsResultWithMetadata | null | undefined
): WidgetUsageScanState {
  const [state, setState] = useState<WidgetUsageScanState>({
    status: "idle",
    usage: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "idle", usage: undefined });
    if (!toolsData?.tools) return;

    setState({ status: "loading", usage: undefined });

    scanWidgetUsage(toolsData, (uri) =>
      readResource(serverName, uri).then(normalizeWidgetResourceReadResult)
    )
      .then((result) => {
        if (cancelled) return;
        setState(
          result === undefined
            ? { status: "failed", usage: undefined }
            : { status: "ready", usage: result }
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "failed", usage: undefined });
      });

    return () => {
      cancelled = true;
    };
    // toolsData identity changes per fetch; that's the intended re-scan key.
  }, [serverName, toolsData]);

  return state;
}

export function useWidgetUsage(
  serverName: string,
  toolsData: ListToolsResultWithMetadata | null | undefined
): WidgetUsage | undefined {
  return useWidgetUsageState(serverName, toolsData).usage;
}
