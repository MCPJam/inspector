import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
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
  resourceUri?: string;
  initialWidgetState?: unknown;
  widgetCsp?: McpUiResourceCsp | null;
  widgetPermissions?: McpUiResourcePermissions | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
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
  input: PersistedExecutionReplayInput
): PersistedExecutionReplay {
  return {
    toolName: input.toolName,
    params: (input.toolInput ?? {}) as Record<string, unknown>,
    result: input.toolOutput,
    toolMeta: input.toolMetadata,
    state: input.toolState,
    errorText: input.toolErrorText,
    toolCallId: input.toolCallId,
    renderOverride: {
      serverId: input.serverId,
      isOffline: input.isOffline,
      cachedWidgetHtmlUrl: input.cachedWidgetHtmlUrl,
      initialWidgetState:
        input.protocol === "openai-apps" ? input.initialWidgetState : undefined,
      resourceUri: input.protocol === "mcp-apps" ? input.resourceUri : undefined,
      toolMetadata: input.toolMetadata,
      widgetCsp: input.protocol === "mcp-apps" ? input.widgetCsp : undefined,
      widgetPermissions:
        input.protocol === "mcp-apps" ? input.widgetPermissions : undefined,
      widgetPermissive:
        input.protocol === "mcp-apps" ? input.widgetPermissive : undefined,
      prefersBorder:
        input.protocol === "mcp-apps" ? input.prefersBorder : undefined,
    },
  };
}
