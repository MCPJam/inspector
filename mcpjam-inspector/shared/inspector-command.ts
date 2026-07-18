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
  | "toggleRegistryStar"
  | "openEvalSuiteForm"
  | "runEvalSuite"
  | "cancelEvalRun"
  | "generateEvalTests"
  | "deleteEvalSuite"
  | "createPersona"
  | "openJourneyForm"
  | "launchSwarmRun";

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
  "openEvalSuiteForm",
  "runEvalSuite",
  "cancelEvalRun",
  "generateEvalTests",
  "deleteEvalSuite",
  "createPersona",
  "openJourneyForm",
  "launchSwarmRun",
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

/**
 * Evals-screen commands, handled by `EvalsTab` while `/evals` is mounted.
 *
 * `suite` is how the model addresses a suite: its id or its name as shown in
 * the suite switcher (timestamp suffixes stripped or not). Handlers resolve
 * it against the loaded suites overview and reject anything else as
 * `invalid_request` — never a fuzzy guess. Runs are addressed by `runId`
 * (full id, or the shortened form the run list displays).
 */

/**
 * Opens the create-suite dialog for the USER to finish. Suite creation is
 * high-entropy (model, servers/host attachments, tests), so the ONLY prefill
 * an agent may pass is the suite name — everything else is picked by the
 * human in the form, mirroring the `openServerForm` prefill-over-commit
 * precedent.
 */
export interface OpenEvalSuiteFormInspectorCommand {
  id: string;
  type: "openEvalSuiteForm";
  payload: { name?: string };
  timeoutMs?: number;
}

/** Starts a suite run. Spends the org's eval iteration quota. */
export interface RunEvalSuiteInspectorCommand {
  id: string;
  type: "runEvalSuite";
  payload: { suite: string };
  timeoutMs?: number;
}

export interface CancelEvalRunInspectorCommand {
  id: string;
  type: "cancelEvalRun";
  payload: { runId: string };
  timeoutMs?: number;
}

/** LLM-generates test cases into the suite. Spends money. */
export interface GenerateEvalTestsInspectorCommand {
  id: string;
  type: "generateEvalTests";
  payload: { suite: string };
  timeoutMs?: number;
}

export interface DeleteEvalSuiteInspectorCommand {
  id: string;
  type: "deleteEvalSuite";
  payload: { suite: string };
  timeoutMs?: number;
}

/**
 * Swarms-screen commands, handled by `SwarmsTab` while `/swarms` is mounted.
 *
 * Personas are addressed by name or id as the Personas list shows them;
 * journeys by their goal text or id as the journey cards show them. Handlers
 * resolve each against the loaded personas/journeys and reject anything else
 * as `invalid_request` (ambiguous → ask for the id) — never a fuzzy guess.
 * The one entity that is created directly is a persona (low-entropy: a name +
 * role + optional notes); a journey targets hosts and sets fan-out config, so
 * its command only PREFILLS the form for the user, mirroring the
 * `openServerForm`/`openEvalSuiteForm` prefill-over-commit precedent.
 */

/**
 * Create a persona directly. Low-entropy: a short name + role, plus optional
 * free-text notes (personality). The new persona becomes the selected one.
 */
export interface CreatePersonaInspectorCommand {
  id: string;
  type: "createPersona";
  payload: { name: string; role: string; notes?: string };
  timeoutMs?: number;
}

/**
 * Open the new-journey form for the USER to finish. A journey is high-entropy
 * (goal, host targeting, sessions-per-host / max-turns), so the ONLY prefill
 * an agent may pass is the goal text — hosts and config are picked by the
 * human. `persona` selects which persona's journey list the form opens under
 * (defaults to the currently selected persona).
 */
export interface OpenJourneyFormInspectorCommand {
  id: string;
  type: "openJourneyForm";
  payload: { persona?: string; goal?: string };
  timeoutMs?: number;
}

/**
 * Launch a run of an existing journey. Fans out one session per
 * (host × sessionsPerHost) and SPENDS the organization's quota — the same
 * gated `launchJourneyRun` REST path the Run button uses, with the same
 * per-launch idempotency key so a retry can't spawn a duplicate run.
 */
export interface LaunchSwarmRunInspectorCommand {
  id: string;
  type: "launchSwarmRun";
  payload: { journey: string };
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
  | ToggleRegistryStarInspectorCommand
  | OpenEvalSuiteFormInspectorCommand
  | RunEvalSuiteInspectorCommand
  | CancelEvalRunInspectorCommand
  | GenerateEvalTestsInspectorCommand
  | DeleteEvalSuiteInspectorCommand
  | CreatePersonaInspectorCommand
  | OpenJourneyFormInspectorCommand
  | LaunchSwarmRunInspectorCommand;

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
