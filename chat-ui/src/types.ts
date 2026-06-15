import type { ToolState } from "./internal/thread-helpers";
import type { UIType } from "./internal/widget-detection";

export type ThemeMode = "light" | "dark" | "system";

/** What to do with widget-bearing tool calls in the read-only renderer. */
export type WidgetPolicy = "placeholder" | "hidden";

export type ReasoningDisplayMode =
  | "inline"
  | "collapsible"
  | "collapsed"
  | "hidden";

/**
 * Package-local replacement for the inspector's `ModelDefinition`. Carries
 * only what the transcript needs for labeling/avatars — no provider SDK types.
 */
export interface ChatUiModel {
  id: string;
  name: string;
  provider: string;
  customProviderName?: string;
}

export const DEFAULT_CHAT_UI_MODEL: ChatUiModel = {
  id: "unknown",
  name: "Unknown",
  provider: "custom",
};

export type ToolServerMap = Record<string, string>;

/**
 * Placeholder for the inspector's `@/lib/client-styles` `OpenAiAppsCapabilities`.
 * Tier A only persists/forwards this opaquely (cached replay wiring for a
 * future Tier B); it never interprets the shape.
 */
export type OpenAiAppsCapabilities = unknown;

/**
 * Opaque placeholders for the MCP Apps SDK types
 * (`@modelcontextprotocol/ext-apps/app-bridge`). Typed as `unknown` because the
 * renderer never interprets them — it only forwards them for cached replay — so
 * a host's real `McpUiResourceCsp` / `McpUiResourcePermissions` (interfaces
 * without index signatures) bridge in without a cast.
 */
export type WidgetCsp = unknown;
export type WidgetPermissions = unknown;

/**
 * Per-tool render override. Fields mirror the inspector's `ToolRenderOverride`,
 * but widget/CSP/capability types are package-local placeholders (see above)
 * so Tier A stays free of the MCP Apps SDK.
 */
export interface ToolRenderOverride {
  serverId?: string;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
  liveFetchPreferred?: boolean;
  toolOutput?: unknown;
  initialWidgetState?: unknown;
  resourceUri?: string;
  toolMetadata?: Record<string, unknown>;
  widgetCsp?: WidgetCsp | null;
  widgetPermissions?: WidgetPermissions | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  injectedOpenAiCompat?: boolean;
  injectedOpenAiCompatCapabilities?: OpenAiAppsCapabilities;
}

/**
 * Context passed to a host-supplied `renderTool` override. The package fills
 * this from the tool part; the inspector uses it to render its interactive
 * `ToolPart` (with save-view, display-mode controls, CSP workbench, etc.)
 * without those concerns ever entering the package.
 */
export interface ToolRenderContext {
  toolName: string;
  toolCallId?: string;
  toolState?: ToolState;
  input: Record<string, unknown> | undefined;
  output: unknown;
  rawOutput: unknown;
  errorText?: string;
  uiType: UIType | null;
  isWidget: boolean;
  serverId?: string;
  toolMetadata?: Record<string, unknown>;
  renderOverride?: ToolRenderOverride;
}

/**
 * Input to a host-supplied `renderWidget`. In Tier A this is never called by
 * the package itself (it renders a placeholder instead); the inspector passes a
 * renderer that mounts its existing `WidgetReplay`.
 */
export interface WidgetRenderInput extends ToolRenderContext {
  resourceUri?: string;
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolServerMap: ToolServerMap;
}
