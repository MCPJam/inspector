import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

export type DisplayMode = "inline" | "pip" | "fullscreen";

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "output-available"
  | "output-denied"
  | "output-error";

export interface MCPAppsRendererProps {
  serverId: string;
  toolCallId: string;
  toolName: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolErrorText?: string;
  resourceUri: string;
  toolMetadata?: Record<string, unknown>;
  toolsMetadata?: Record<string, Record<string, unknown>>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  onAppSupportedDisplayModesChange?: (modes: DisplayMode[] | undefined) => void;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
}

export const DEFAULT_INPUT_SCHEMA = { type: "object" } as const;

export const PARTIAL_INPUT_THROTTLE_MS = 120;
export const STREAMING_REVEAL_FALLBACK_MS = 700;
export const SIGNATURE_MAX_DEPTH = 4;
export const SIGNATURE_MAX_ARRAY_ITEMS = 24;
export const SIGNATURE_MAX_OBJECT_KEYS = 32;
export const SIGNATURE_STRING_EDGE_LENGTH = 24;

export const SUPPRESSED_UI_LOG_METHODS = new Set([
  "ui/notifications/size-changed",
]);
