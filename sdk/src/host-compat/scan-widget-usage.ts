import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  scanWidgetMeta,
  scanWidgetSource,
  type WidgetCapabilityNeed,
  type WidgetUsage,
} from "./widget-scan.js";
import type { HostCompatToolsInput } from "./server-requirements.js";

/** A resource read shaped like an MCP `resources/read` result. */
export interface ReadResourceResult {
  contents?: Array<{ text?: string; blob?: string; _meta?: unknown }>;
}

/** Injected `resources/read` — browser, Node, CLI, and API each supply theirs. */
export type ReadResourceFn = (uri: string) => Promise<ReadResourceResult>;

/**
 * The widget's readable resource URI — MCP Apps `_meta.ui.resourceUri`, else
 * the OpenAI Apps `openai/outputTemplate`. Both are `ui://` resources read the
 * same way; an OpenAI-only widget must still be scanned (skipping it would let
 * `scanWidgetUsage` return a false "scanned clean").
 */
function widgetResourceUri(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const mcpApps = getToolUiResourceUri({ _meta: meta });
  if (mcpApps) return mcpApps;
  const openai = meta?.["openai/outputTemplate"];
  return typeof openai === "string" && openai.length > 0 ? openai : undefined;
}

function htmlFromContent(content: { text?: string; blob?: string }): string {
  if (typeof content.text === "string") return content.text;
  if (typeof content.blob === "string") {
    try {
      return atob(content.blob);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * L1 widget-usage scan for one server's tools — the shared contract behind the
 * inspector hook, the CLI, and the API. For each widget-bearing tool, reads its
 * UI resource via the injected `readResource`, then scans the HTML (+ the
 * resource's declared `_meta.ui`) for the host APIs it uses.
 *
 * Each widget URI is read once even when several tools share it; every tool
 * pointing at that widget inherits its needs.
 *
 * Returns `undefined` when the tools aren't loaded OR every read failed — the
 * load-bearing "unknown" the engine needs so it withholds capability findings
 * rather than guess. `{}` means "scanned, nothing notable used".
 */
export async function scanWidgetUsage(
  toolsData: HostCompatToolsInput | null | undefined,
  readResource: ReadResourceFn,
): Promise<WidgetUsage | undefined> {
  if (!toolsData?.tools) return undefined;

  // Group tools by their MCP Apps resource URI so each resource is read once.
  const toolsByUri = new Map<string, string[]>();
  for (const tool of toolsData.tools) {
    const meta =
      toolsData.toolsMetadata?.[tool.name] ??
      (tool._meta as Record<string, unknown> | undefined);
    const uri = widgetResourceUri(meta);
    if (uri) toolsByUri.set(uri, [...(toolsByUri.get(uri) ?? []), tool.name]);
  }
  if (toolsByUri.size === 0) return {};

  const acc: WidgetUsage = {};
  const add = (need: WidgetCapabilityNeed, tools: string[]) => {
    acc[need] = Array.from(new Set([...(acc[need] ?? []), ...tools]));
  };

  // Track whether ANY read succeeded — if all fail, return undefined (Unknown),
  // never `{}` (which reads as a conclusive clean scan and lets a host "work").
  const readResults = await Promise.all(
    Array.from(toolsByUri.entries()).map(async ([uri, toolNames]) => {
      try {
        const result = await readResource(uri);
        const content = result?.contents?.[0];
        if (content) {
          const needs = new Set<WidgetCapabilityNeed>([
            ...scanWidgetSource(htmlFromContent(content)),
            ...scanWidgetMeta(content._meta),
          ]);
          for (const need of needs) add(need, toolNames);
        }
        return true;
      } catch {
        return false;
      }
    }),
  );

  return readResults.some(Boolean) ? acc : undefined;
}
