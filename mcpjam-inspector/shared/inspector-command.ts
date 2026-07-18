import type { AppSurfaceId } from "./app-surfaces";

/**
 * Device-emulation targets addressable via commands. `"fill"` is the
 * playground store's DEFAULT (fit the panel) — included so an agent can
 * restore the default after switching to a fixed-size preset.
 */
export type InspectorAppDeviceType =
  | "fill"
  | "mobile"
  | "tablet"
  | "desktop"
  | "custom";
export type InspectorAppDisplayMode = "inline" | "pip" | "fullscreen";

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
  | "openPlayground"
  | "setAppContext"
  | "selectTool"
  | "executeTool"
  | "renderToolResult"
  | "snapshotApp"
  | "openServerForm"
  | "addServer"
  | "connectServer"
  | "disconnectServer"
  | "removeServer"
  | "connectRegistryServer"
  | "disconnectRegistryServer"
  | "toggleRegistryStar";

export const KNOWN_INSPECTOR_COMMAND_TYPES = [
  "navigate",
  "selectServer",
  "openPlayground",
  "setAppContext",
  "selectTool",
  "executeTool",
  "renderToolResult",
  "snapshotApp",
  "openServerForm",
  "addServer",
  "connectServer",
  "disconnectServer",
  "removeServer",
  "connectRegistryServer",
  "disconnectRegistryServer",
  "toggleRegistryStar",
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

export interface OpenPlaygroundInspectorCommand {
  id: string;
  type: "openPlayground";
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
  };
  timeoutMs?: number;
}

export interface ToolInvocationPayload {
  surface: "tools" | "playground";
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
    surface: "tools" | "playground";
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
  /**
   * `surface` narrows the snapshot to one screen; omitted means the whole
   * app (app-level state plus every mounted surface's provider).
   *
   * Typed as `AppSurfaceId`, but handlers cast the raw command rather than
   * parse it, so the TYPE is not a runtime check — the handler validates
   * with `isAppSurfaceId` and rejects anything else as `invalid_request`.
   * An arbitrary string must never reach the provider registry as a lookup.
   */
  payload: { surface?: AppSurfaceId };
  timeoutMs?: number;
}

/**
 * Connect-screen server config an agent can author.
 *
 * A deliberate SUBSET of the form's `ServerFormData`, and the exclusions are
 * a security boundary, not an oversight. No credentials, no OAuth client
 * secrets, no XAA identity — and, per review, no `env`/`headers` either:
 * those routinely carry API keys and bearer tokens, and everything in this
 * draft passes through the chat/tool transcript. A server that needs secret
 * env or headers is set up by the agent prefilling the non-secret fields via
 * `ui_open_server_form`, then the USER typing the secrets into the form,
 * where they never reach the transcript.
 *
 * `args` is a list rather than part of `command` because the form's parser
 * splits on whitespace with no quote handling: `npx -y pkg --flag "a b"`
 * would split wrong. Taking them pre-separated sidesteps that entirely.
 */
export interface InspectorServerDraft {
  name: string;
  /** Defaults to "http", matching the form's own default for a new server. */
  transport?: "http" | "stdio";
  /** HTTP only. Hosted deployments require https. */
  url?: string;
  /** STDIO only: the executable, with no arguments in it. */
  command?: string;
  /** STDIO only. */
  args?: string[];
}

export interface OpenServerFormInspectorCommand {
  id: string;
  type: "openServerForm";
  /**
   * Optional prefill. Every field is optional — the point of this command is
   * to open the form for the USER to finish, so a blank or partial prefill is
   * valid and must NOT be validated as a complete server config.
   */
  payload: { draft?: Partial<InspectorServerDraft> };
  timeoutMs?: number;
}

export interface AddServerInspectorCommand {
  id: string;
  type: "addServer";
  payload: { draft: InspectorServerDraft };
  timeoutMs?: number;
}

export interface ConnectServerInspectorCommand {
  id: string;
  type: "connectServer";
  payload: { serverName: string };
  timeoutMs?: number;
}

export interface DisconnectServerInspectorCommand {
  id: string;
  type: "disconnectServer";
  payload: { serverName: string };
  timeoutMs?: number;
}

export interface RemoveServerInspectorCommand {
  id: string;
  type: "removeServer";
  payload: { serverName: string };
  timeoutMs?: number;
}

/**
 * Registry-screen commands, handled by `RegistryTab` while `/registry` is
 * mounted (the first mount-scoped surface tool group).
 *
 * `serverName` is how the model addresses a catalog entry: the card's
 * display name ("Asana"), its registry name ("com.asana.mcp"), or the
 * project server name a variant creates ("Asana (App)"). Handlers resolve
 * it against the loaded catalog and reject anything else as
 * `unknown_server` — never a fuzzy guess. `variant` picks between a
 * dual-type card's Text and App entries.
 */
export interface ConnectRegistryServerInspectorCommand {
  id: string;
  type: "connectRegistryServer";
  payload: { serverName: string; variant?: "text" | "app" };
  timeoutMs?: number;
}

export interface DisconnectRegistryServerInspectorCommand {
  id: string;
  type: "disconnectRegistryServer";
  payload: { serverName: string; variant?: "text" | "app" };
  timeoutMs?: number;
}

/**
 * `starred` is the explicit TARGET state, not a toggle: the star buttons
 * flip whatever is current, but an agent retrying a toggle would flip the
 * state back — set-to-state keeps the command idempotent.
 */
export interface ToggleRegistryStarInspectorCommand {
  id: string;
  type: "toggleRegistryStar";
  payload: { serverName: string; starred: boolean };
  timeoutMs?: number;
}

export type InspectorCommand =
  | NavigateInspectorCommand
  | SelectServerInspectorCommand
  | OpenPlaygroundInspectorCommand
  | SetAppContextInspectorCommand
  | SelectToolInspectorCommand
  | ExecuteToolInspectorCommand
  | RenderToolResultInspectorCommand
  | SnapshotAppInspectorCommand
  | OpenServerFormInspectorCommand
  | AddServerInspectorCommand
  | ConnectServerInspectorCommand
  | DisconnectServerInspectorCommand
  | RemoveServerInspectorCommand
  | ConnectRegistryServerInspectorCommand
  | DisconnectRegistryServerInspectorCommand
  | ToggleRegistryStarInspectorCommand;

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
