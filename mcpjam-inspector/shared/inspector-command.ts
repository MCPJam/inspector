export type InspectorAppDeviceType = "mobile" | "tablet" | "desktop" | "custom";
export type InspectorAppDisplayMode = "inline" | "pip" | "fullscreen";
export type InspectorAppProtocol = "mcp-apps" | "openai-sdk";

export const INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;

export type InspectorCommandErrorCode =
  | "no_active_client"
  | "unknown_server"
  | "disconnected_server"
  | "unknown_tool"
  | "unknown_command_id"
  | "timeout"
  | "unsupported_in_mode"
  | "invalid_request"
  | "execution_failed";

export type InspectorCommandType =
  | "navigate"
  | "selectServer"
  | "openAppBuilder"
  | "setAppContext"
  | "selectTool"
  | "executeTool"
  | "renderToolResult"
  | "snapshotApp";

export const KNOWN_INSPECTOR_COMMAND_TYPES = [
  "navigate",
  "selectServer",
  "openAppBuilder",
  "setAppContext",
  "selectTool",
  "executeTool",
  "renderToolResult",
  "snapshotApp",
] as const satisfies readonly InspectorCommandType[];

export interface InspectorCommandError {
  code: InspectorCommandErrorCode;
  message: string;
  details?: unknown;
}

export interface NavigateInspectorCommand {
  id: string;
  type: "navigate";
  payload: { target: string };
  timeoutMs?: number;
}

export interface SelectServerInspectorCommand {
  id: string;
  type: "selectServer";
  payload: { serverName: string };
  timeoutMs?: number;
}

export interface OpenAppBuilderInspectorCommand {
  id: string;
  type: "openAppBuilder";
  payload: { serverName?: string };
  timeoutMs?: number;
}

export interface SetAppContextInspectorCommand {
  id: string;
  type: "setAppContext";
  payload: {
    deviceType?: InspectorAppDeviceType;
    displayMode?: InspectorAppDisplayMode;
    locale?: string;
    timeZone?: string;
    theme?: "light" | "dark";
    protocol?: InspectorAppProtocol;
  };
  timeoutMs?: number;
}

export interface ToolInvocationPayload {
  surface: "tools" | "app-builder";
  serverName?: string;
  toolName: string;
  parameters?: Record<string, unknown>;
}

export interface SelectToolInspectorCommand {
  id: string;
  type: "selectTool";
  payload: ToolInvocationPayload;
  timeoutMs?: number;
}

export interface ExecuteToolInspectorCommand {
  id: string;
  type: "executeTool";
  payload: ToolInvocationPayload;
  timeoutMs?: number;
}

export interface RenderToolResultInspectorCommand {
  id: string;
  type: "renderToolResult";
  payload: {
    surface: "tools" | "app-builder";
    serverName?: string;
    toolName: string;
    parameters?: Record<string, unknown>;
    result: unknown;
  };
  timeoutMs?: number;
}

export interface SnapshotAppInspectorCommand {
  id: string;
  type: "snapshotApp";
  payload: { surface?: "app-builder" };
  timeoutMs?: number;
}

export type InspectorCommand =
  | NavigateInspectorCommand
  | SelectServerInspectorCommand
  | OpenAppBuilderInspectorCommand
  | SetAppContextInspectorCommand
  | SelectToolInspectorCommand
  | ExecuteToolInspectorCommand
  | RenderToolResultInspectorCommand
  | SnapshotAppInspectorCommand;

export interface InspectorCommandSuccessResponse {
  id: string;
  status: "success";
  result?: unknown;
}

export interface InspectorCommandErrorResponse {
  id: string;
  status: "error";
  error: InspectorCommandError;
}

export type InspectorCommandResponse =
  | InspectorCommandSuccessResponse
  | InspectorCommandErrorResponse;

export function isInspectorCommandType(
  value: unknown,
): value is InspectorCommandType {
  return (
    typeof value === "string" &&
    (KNOWN_INSPECTOR_COMMAND_TYPES as readonly string[]).includes(value)
  );
}

export function buildInspectorCommandError(
  code: InspectorCommandErrorCode,
  message: string,
  details?: unknown,
): InspectorCommandError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}
