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
  // Input's real MCP-Apps types widen into the package's `unknown` placeholders;
  // the produced override's placeholder widget/CSP fields are bridged back to
  // the inspector's real types here.
  return buildPersistedExecutionReplayImpl(
    input,
  ) as unknown as PersistedExecutionReplay;
}
