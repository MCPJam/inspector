// Inspector boundary shim. The persisted-execution replay builder LOGIC is
// single-sourced in @mcpjam/chat-ui/trace; this module keeps the inspector's
// real MCP-Apps SDK widget/CSP types on the input/output (the package uses
// opaque `unknown` placeholders) and delegates the builder to the package.
import { buildPersistedExecutionReplay as buildPersistedExecutionReplayImpl } from "@mcpjam/chat-ui/trace";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { OpenAiAppsCapabilities } from "@/lib/client-styles";
import type { ToolRenderOverride } from "./tool-render-overrides";

export interface PersistedExecutionReplayInput {
  protocol: "mcp-apps" | "openai-apps";
  toolCallId: string;
  toolName: string;
  toolInput?: Record<string, unknown> | null;
  toolOutput: unknown;
  toolState: "output-available" | "output-error";
  toolErrorText?: string;
  toolMetadata?: Record<string, unknown>;
  serverId: string;
  isOffline: boolean;
  cachedWidgetHtmlUrl?: string;
  /** See ToolRenderOverride.liveFetchPreferred. */
  liveFetchPreferred?: boolean;
  resourceUri?: string;
  initialWidgetState?: unknown;
  widgetCsp?: McpUiResourceCsp | null;
  widgetPermissions?: McpUiResourcePermissions | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  injectedOpenAiCompat?: boolean;
  injectedOpenAiCompatCapabilities?: OpenAiAppsCapabilities;
}

export interface PersistedExecutionReplay {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  toolMeta?: Record<string, unknown>;
  state: "output-available" | "output-error";
  errorText?: string;
  toolCallId: string;
  renderOverride: ToolRenderOverride;
}

export function buildPersistedExecutionReplay(
  input: PersistedExecutionReplayInput,
): PersistedExecutionReplay {
  // Input's real MCP-Apps types widen into the package's `unknown` placeholders.
  // Only `renderOverride` carries the placeholder widget/CSP types, so narrow
  // the cast to that field and keep the rest structurally checked against the
  // package shape.
  const replay = buildPersistedExecutionReplayImpl(input);
  return {
    ...replay,
    renderOverride: replay.renderOverride as ToolRenderOverride,
  };
}
