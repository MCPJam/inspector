import type {
  OpenAiAppsCapabilities,
  ToolRenderOverride,
  WidgetCsp,
  WidgetPermissions,
} from "../types";

// Ported from the inspector
// (`components/chat-v2/thread/persisted-execution-replay.ts`). The widget/CSP
// capability types are package-local placeholders (see `../types`) so the
// builder stays free of the MCP Apps SDK. Behaviour is unchanged.

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
  widgetCsp?: WidgetCsp | null;
  widgetPermissions?: WidgetPermissions | null;
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
      liveFetchPreferred: input.liveFetchPreferred,
      toolOutput: input.toolOutput,
      initialWidgetState:
        input.protocol === "openai-apps" ? input.initialWidgetState : undefined,
      resourceUri:
        input.protocol === "mcp-apps" ? input.resourceUri : undefined,
      toolMetadata: input.toolMetadata,
      widgetCsp: input.protocol === "mcp-apps" ? input.widgetCsp : undefined,
      widgetPermissions:
        input.protocol === "mcp-apps" ? input.widgetPermissions : undefined,
      widgetPermissive:
        input.protocol === "mcp-apps" ? input.widgetPermissive : undefined,
      prefersBorder:
        input.protocol === "mcp-apps" ? input.prefersBorder : undefined,
      injectedOpenAiCompat: input.injectedOpenAiCompat,
      injectedOpenAiCompatCapabilities: input.injectedOpenAiCompatCapabilities,
    },
  };
}
