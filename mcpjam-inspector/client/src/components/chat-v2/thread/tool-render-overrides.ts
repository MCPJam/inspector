import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export interface ToolRenderOverride {
  serverId?: string;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
  /**
   * Recorded screenshot of how this tool's widget ACTUALLY rendered during the
   * run (from the eval `widgetRenderObservations`). When set, the transcript
   * shows this frozen image INSTEAD of mounting a live widget — so a completed
   * run's replay can't drift to the widget's default state when its backing MCP
   * server is gone. Only the eval trace-viewer sets this, only for completed,
   * non-interactive runs; live/record-armed surfaces leave it unset.
   */
  frozenScreenshotUrl?: string | null;
  /**
   * Try the live MCP Apps fetch path before falling back to
   * `cachedWidgetHtmlUrl`. Used by in-flow session revisit so the widget
   * re-renders against the active host's current CSP / bridge state when the
   * server is still reachable, while still surviving server disconnect by
   * falling back to the cached snapshot HTML.
   *
   * When unset (the default), the cached path is taken whenever
   * `cachedWidgetHtmlUrl` is present — matching the original offline-replay
   * semantics used by the Views tab and persisted eval traces.
   */
  liveFetchPreferred?: boolean;
  toolOutput?: unknown;
  initialWidgetState?: unknown;
  resourceUri?: string;
  toolMetadata?: Record<string, unknown>;
  widgetCsp?: McpUiResourceCsp | null;
  widgetPermissions?: McpUiResourcePermissions | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  /**
   * Persisted compat-runtime flag for cached/offline replay — the
   * cached HTML blob was captured with this flag's value, and the
   * renderer uses it as the authoritative reload-key for the cached
   * branch (live host flag is ignored when HTML is frozen).
   */
  injectedOpenAiCompat?: boolean;
  /**
   * Persisted per-method `window.openai.*` surface that was injected
   * into the cached HTML blob. Sibling of `injectedOpenAiCompat`; the
   * boolean tells the renderer "shim or not", the matrix tells it
   * "which methods" so replay reproduces the same API surface even
   * when the live host config has since changed. Absent for
   * pre-feature snapshots — replay treats those as the full ChatGPT
   * surface (runtime default at capture time).
   */
  injectedOpenAiCompatCapabilities?: import("@/lib/client-styles").OpenAiAppsCapabilities;
}

/**
 * Whether `PartSwitch` enters the widget-slot render block for a tool. True when
 * the tool is live-widget eligible OR a frozen recorded screenshot exists. The
 * frozen capture (eval replay) must show even when live rendering is
 * unavailable — a completed run's widget can fail host-caps / server / `uiType`
 * checks at view-time, but we still have its screenshot. See
 * [[feedback_check_gate_not_just_join]].
 */
export function widgetSlotShouldRender(
  liveWidgetEligible: boolean,
  override: Pick<ToolRenderOverride, "frozenScreenshotUrl"> | undefined
): boolean {
  return liveWidgetEligible || !!override?.frozenScreenshotUrl;
}
