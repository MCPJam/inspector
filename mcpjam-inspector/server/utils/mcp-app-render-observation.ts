/**
 * mcp-app-render-observation.ts — read an MCP App tool result's UI resource and
 * render it in the browser harness, producing a WidgetRenderObservation.
 *
 * Browser-rendered MCP App eval PR 5. Shared helper used by the eval runner's
 * render-check path: it reads the widget HTML the same way
 * `captureMcpAppWidgetSnapshots` does (resource read + OpenAI-compat shim +
 * `_meta.ui` policy), then hands it to the harness (PR 3). Keeping this in one
 * place means render observations and the legacy HTML snapshots agree on what
 * a widget tool result resolves to.
 */

import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { isMcpAppTool, type MCPClientManager } from "@mcpjam/sdk";
import { injectOpenAICompat } from "./widget-helpers";
import {
  extractHtmlFromResourceContent,
  isRecord,
  normalizeWidgetPermissions,
} from "./mcp-app-widget-capture";
import type {
  McpAppBrowserHarness,
  WidgetRenderObservation,
} from "./mcp-app-browser-harness";

export interface RenderMcpAppToolResultParams {
  toolCallId: string;
  toolName: string;
  serverId: string;
  /** Tool metadata (from `mcpClientManager.getAllToolsMetadata`). */
  toolMetadata: Record<string, unknown>;
  /** The tool result output (delivered to the widget as toolOutput). */
  output?: unknown;
  /** The tool-call input (delivered to the widget as toolInput), if known. */
  toolInput?: Record<string, unknown>;
  mcpClientManager: MCPClientManager;
  /** Inject the OpenAI Apps SDK `window.openai` shim (host-config resolved). */
  injectOpenAiCompat?: boolean;
  harness: McpAppBrowserHarness;
  /** Keep the widget mounted for subsequent Computer Use actions. */
  keepMounted?: boolean;
}

/**
 * Returns `true` when the tool's metadata marks it as an MCP App (SEP-1865) and
 * declares a UI resource — i.e. a tool result worth render-checking.
 */
export function isRenderableMcpAppTool(
  toolMetadata: unknown,
): toolMetadata is Record<string, unknown> {
  if (!isRecord(toolMetadata) || !isMcpAppTool(toolMetadata)) return false;
  return Boolean(getToolUiResourceUri({ _meta: toolMetadata }));
}

/**
 * Read the widget HTML for an MCP App tool result and render it in the harness.
 * Returns a WidgetRenderObservation; on resource problems it short-circuits
 * with `no_ui_resource` / `resource_read_failed` without launching the browser.
 */
export async function renderMcpAppToolResult(
  params: RenderMcpAppToolResultParams,
): Promise<WidgetRenderObservation> {
  const { toolCallId, toolName, serverId, toolMetadata, mcpClientManager } =
    params;
  const ts = Date.now();
  const base = { toolCallId, toolName, serverId, ts };

  const resourceUri = getToolUiResourceUri({ _meta: toolMetadata });
  if (!resourceUri) {
    return { ...base, status: "no_ui_resource", elapsedMs: 0 };
  }

  let html: string | undefined;
  let permissions: Record<string, unknown> | undefined;
  try {
    const resourceResult = await mcpClientManager.readResource(serverId, {
      uri: resourceUri,
    });
    const contents = Array.isArray(
      (resourceResult as { contents?: unknown[] })?.contents,
    )
      ? ((resourceResult as { contents: unknown[] }).contents as unknown[])
      : [];
    const content = contents[0];
    if (isRecord(content)) {
      const uiMeta =
        isRecord(content._meta) && isRecord(content._meta.ui)
          ? (content._meta.ui as Record<string, unknown>)
          : undefined;
      permissions = normalizeWidgetPermissions(uiMeta?.permissions) ?? undefined;
      html = extractHtmlFromResourceContent(content);
    }
  } catch {
    return {
      ...base,
      status: "resource_read_failed",
      resourceUri,
      elapsedMs: Date.now() - ts,
    };
  }

  if (!html) {
    return {
      ...base,
      status: "no_ui_resource",
      resourceUri,
      elapsedMs: Date.now() - ts,
    };
  }

  const widgetHtml = params.injectOpenAiCompat
    ? injectOpenAICompat(html, {
        toolId: toolCallId,
        toolName,
        toolInput: params.toolInput ?? {},
        toolOutput: params.output,
      })
    : html;

  return params.harness.renderWidget({
    toolCallId,
    toolName,
    serverId,
    html: widgetHtml,
    resourceUri,
    toolInput: params.toolInput,
    toolOutput: params.output,
    permissions,
    keepMounted: params.keepMounted,
  });
}
