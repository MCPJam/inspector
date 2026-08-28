/**
 * widget-render-core.ts — the shared gate-first render flow behind both the
 * one-shot `POST /api/mcp/widget-render` and the interactive
 * `POST /api/mcp/widget-session` (start). Centralizes: populate tool metadata
 * (listTools) -> renderability gate -> (only if renderable) executeTool ->
 * harness render. Gating before execution means a non-widget, side-effectful
 * tool isn't run just to discover it has no UI.
 *
 * The caller owns the returned harness's lifecycle: the one-shot route disposes
 * it immediately; the session route keeps it mounted (keepMounted) and registers
 * it, disposing only on a non-rendered verdict or capacity rejection.
 */

import { randomUUID } from "node:crypto";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  McpAppBrowserHarness,
  ChromiumNotInstalledError,
  type WidgetRenderObservation,
  type WidgetSnapshot,
} from "./mcp-app-browser-harness";
import {
  renderMcpAppToolResult,
  isRenderableMcpAppTool,
} from "./mcp-app-render-observation";

/** Actionable hint surfaced when the harness reports `browser_unavailable`. */
export const CHROMIUM_INSTALL_HINT = "npx playwright install chromium";

/** Safety bound on `tools/list` pages drained while resolving a tool's metadata
 *  (a server that loops cursors forever can't hang the gate). 50 pages covers
 *  any realistic tool count. */
const MAX_TOOL_LIST_PAGES = 50;

export interface RenderWidgetForRequestParams {
  mcpClientManager: MCPClientManager;
  serverId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  injectOpenAiCompat: boolean;
  viewport?: { width: number; height: number };
  /** Keep the widget mounted (for an interactive session) vs one-shot. */
  keepMounted: boolean;
  /**
   * Also capture a TEXT view of the rendered widget (accessibility tree +
   * addressable elements).
   *
   * Handled HERE rather than by each caller because the timing is the whole
   * difficulty: a one-shot render unmounts the widget when it is done, so a
   * caller that tried to snapshot afterwards would find nothing. Requesting it
   * keeps the widget mounted just long enough to read, then lets the normal
   * teardown proceed.
   */
  captureSnapshot?: boolean;
}

export interface RenderWidgetForRequestResult {
  observation: WidgetRenderObservation;
  /**
   * Present only when `captureSnapshot` was requested AND a widget actually
   * mounted. Absent rather than empty on a failed render: an empty tree would
   * claim the widget rendered with no content.
   */
  snapshot?: WidgetSnapshot;
  /**
   * The harness, when one was created (the tool was renderable). `null` for the
   * `no_ui_resource` gate (no browser launched). The CALLER owns disposal.
   */
  harness: McpAppBrowserHarness | null;
}

/**
 * Run the gate-first render flow. Throws on a protocol-level failure of
 * `listTools` / `executeTool` (the caller maps that to a 500); a missing
 * Chromium is reported in-band as a `browser_unavailable` observation, not a
 * throw.
 */
export async function renderWidgetForRequest(
  params: RenderWidgetForRequestParams,
): Promise<RenderWidgetForRequestResult> {
  const { mcpClientManager, serverId, toolName, parameters } = params;
  const startedAt = Date.now();

  // Resolve the tool's declared `_meta` by listing the server's tools:
  // connecting does NOT list them, and executeTool doesn't cache metadata, so
  // without this the gate below would always see empty metadata (=>
  // no_ui_resource). `tools/list` can paginate, and the manager's metadata cache
  // only retains the LAST page — so read each page's `_meta` directly and drain
  // pages until we find `toolName` (a renderable tool on page 2+ must not be
  // missed).
  let toolMetadata: Record<string, unknown> = {};
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const { tools, nextCursor } = await mcpClientManager.listTools(
      serverId,
      // Presence, not truthiness: `""` is a valid continuation cursor.
      cursor !== undefined ? { cursor } : undefined,
    );
    const match = tools.find((tool) => tool.name === toolName);
    if (match) {
      toolMetadata = (match._meta ?? {}) as Record<string, unknown>;
      break;
    }
    // Stop at the last page, or if the server loops a cursor (no progress).
    // "Last page" means NO cursor — MCP 2026-07-28
    // `server/utilities/pagination` makes `""` a valid cursor that MUST NOT be
    // treated as the end of results, and it joins `seenCursors` like any other
    // token so a server looping on `""` still stops here.
    if (typeof nextCursor !== "string" || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  // Gate BEFORE executing — a non-MCP-App / resource-less tool has no widget to
  // mount, so report no_ui_resource without running a possibly side-effectful
  // tool or launching a browser.
  if (!isRenderableMcpAppTool(toolMetadata)) {
    return {
      observation: {
        toolCallId: `widget-render-${randomUUID()}`,
        toolName,
        serverId,
        status: "no_ui_resource",
        elapsedMs: Date.now() - startedAt,
        ts: Date.now(),
      },
      harness: null,
    };
  }

  // The widget renders THIS result. `isError: true` is still a result — the
  // widget may render its error state — so it flows through unchanged.
  const rawResult = await mcpClientManager.executeTool(
    serverId,
    toolName,
    parameters,
  );

  const harness = new McpAppBrowserHarness({
    callTool: (s, n, a) => mcpClientManager.executeTool(s, n, a),
    ...(params.viewport ? { viewport: params.viewport } : {}),
  });

  try {
    const observation = await renderMcpAppToolResult({
      toolCallId: `widget-render-${randomUUID()}`,
      toolName,
      serverId,
      toolMetadata,
      output: rawResult,
      toolInput: parameters,
      mcpClientManager,
      injectOpenAiCompat: params.injectOpenAiCompat,
      harness,
      // A snapshot needs something mounted to read. Requesting one therefore
      // implies keeping the widget up through the read; the caller's teardown
      // is unchanged and still runs immediately after.
      keepMounted: params.keepMounted || params.captureSnapshot === true,
    });
    let snapshot: WidgetSnapshot | undefined;
    if (params.captureSnapshot && observation.status === "rendered") {
      // Best-effort: a snapshot is diagnostic, and failing a completed render
      // because the text view could not be read would be the observability
      // breaking the thing it observes.
      snapshot = await harness
        .captureSnapshot(observation.toolCallId)
        .catch(() => undefined);
      // Restore the one-shot contract: the caller asked for a render, not a
      // live session, and leaving the widget mounted would change teardown
      // semantics for a diagnostic opt-in.
      if (!params.keepMounted) {
        await harness.dismissWidget(observation.toolCallId).catch(() => {});
      }
    }
    return { observation, ...(snapshot ? { snapshot } : {}), harness };
  } catch (error) {
    // The harness maps a missing-Chromium launch to a `browser_unavailable`
    // observation itself (it does NOT throw); this defensive branch covers the
    // throw path in case that contract changes. Any other render error leaks
    // nothing — dispose the just-created harness and rethrow for a 500.
    if (error instanceof ChromiumNotInstalledError) {
      return {
        observation: {
          toolCallId: `widget-render-${randomUUID()}`,
          toolName,
          serverId,
          status: "browser_unavailable",
          elapsedMs: Date.now() - startedAt,
          ts: Date.now(),
        },
        harness,
      };
    }
    await harness.dispose().catch(() => {});
    throw error;
  }
}

/**
 * Map a render observation to the JSON response fields shared by both routes:
 * the verdict plus diagnostics, with the install hint attached on
 * `browser_unavailable`. Omits absent optional fields to keep payloads tight.
 */
export function buildWidgetRenderResponseBody(
  observation: WidgetRenderObservation,
): Record<string, unknown> {
  return {
    status: observation.status,
    ...(observation.resourceUri
      ? { resourceUri: observation.resourceUri }
      : {}),
    ...(observation.bridgeInitialized !== undefined
      ? { bridgeInitialized: observation.bridgeInitialized }
      : {}),
    ...(observation.screenshotBase64
      ? { screenshotBase64: observation.screenshotBase64 }
      : {}),
    ...(observation.consoleErrors
      ? { consoleErrors: observation.consoleErrors }
      : {}),
    ...(observation.blockedRequests
      ? { blockedRequests: observation.blockedRequests }
      : {}),
    elapsedMs: observation.elapsedMs,
    ...(observation.status === "browser_unavailable"
      ? { hint: CHROMIUM_INSTALL_HINT }
      : {}),
  };
}
