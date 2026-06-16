import { useEffect, useState } from "react";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { readResource } from "@/lib/apis/mcp-resources-api";
import { detectUIType, getUIResourceUri } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  scanWidgetMeta,
  scanWidgetSource,
  type WidgetCapabilityNeed,
  type WidgetUsage,
} from "./widget-scan";

type WidgetTarget = { toolName: string; uri: string };

function collectWidgetTargets(
  toolsData: ListToolsResultWithMetadata,
): WidgetTarget[] {
  const targets: WidgetTarget[] = [];
  for (const tool of toolsData.tools ?? []) {
    const meta =
      toolsData.toolsMetadata?.[tool.name] ??
      (tool._meta as Record<string, unknown> | undefined);
    const uri = getUIResourceUri(detectUIType(meta, undefined), meta);
    if (uri) targets.push({ toolName: tool.name, uri });
  }
  return targets;
}

function htmlFromResource(resource: {
  text?: string;
  blob?: string;
}): string {
  if (typeof resource.text === "string") return resource.text;
  if (typeof resource.blob === "string") {
    try {
      return atob(resource.blob);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * L1 widget scan for one server's tools: reads each widget's HTML via
 * `resources/read` and scans it (plus the resource's declared `_meta.ui`)
 * for the host APIs it uses. Returns `undefined` until the scan resolves so
 * the engine can withhold capability findings rather than guess; `{}` means
 * "scanned, nothing notable used".
 *
 * Each widget URI is read once even when several tools share it; every
 * tool pointing at that widget inherits its needs.
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

    const targets = collectWidgetTargets(toolsData);
    if (targets.length === 0) {
      setUsage({});
      return;
    }

    // Group tools by widget URI so each resource is fetched once.
    const toolsByUri = new Map<string, string[]>();
    for (const { uri, toolName } of targets) {
      toolsByUri.set(uri, [...(toolsByUri.get(uri) ?? []), toolName]);
    }

    (async () => {
      const acc: WidgetUsage = {};
      const add = (need: WidgetCapabilityNeed, tools: string[]) => {
        acc[need] = Array.from(new Set([...(acc[need] ?? []), ...tools]));
      };
      // Track whether ANY widget was actually read. If every read fails we
      // must NOT report `{}` (which reads as a conclusive "scanned, clean"
      // and lets a host show Works) — return `undefined` so the engine keeps
      // the capability dimension Unknown instead of guessing.
      const readResults = await Promise.all(
        Array.from(toolsByUri.entries()).map(async ([uri, toolNames]) => {
          try {
            const result = (await readResource(serverName, uri)) as {
              contents?: Array<{ text?: string; blob?: string; _meta?: unknown }>;
            };
            const content = result?.contents?.[0];
            if (content) {
              const needs = new Set<WidgetCapabilityNeed>([
                ...scanWidgetSource(htmlFromResource(content)),
                ...scanWidgetMeta(content._meta),
              ]);
              for (const need of needs) add(need, toolNames);
            }
            return true; // the read itself succeeded
          } catch {
            return false; // couldn't read this widget
          }
        }),
      );
      if (cancelled) return;
      const anyRead = readResults.some(Boolean);
      setUsage(anyRead ? acc : undefined);
    })();

    return () => {
      cancelled = true;
    };
    // toolsData identity changes per fetch; that's the intended re-scan key.
  }, [serverName, toolsData]);

  return usage;
}
