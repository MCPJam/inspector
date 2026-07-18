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
  | "launchSwarmRun"
  | "createHost"
  | "openHostEditor"
  | "setHostServers"
  | "deleteHost"
  | "duplicateHost"
  | "startComputer"
  | "hibernateComputer"
  | "resetComputer"
  | "deleteComputer"
  | "publishChatbox"
  | "generateChatboxSessions"
  | "deleteChatbox"
  | "selectModel"
  | "setSystemPrompt"
  | "resetChat"
  | "stopGeneration";

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
  "createHost",
  "openHostEditor",
  "setHostServers",
  "deleteHost",
  "duplicateHost",
  "startComputer",
  "hibernateComputer",
  "resetComputer",
  "deleteComputer",
  "publishChatbox",
  "generateChatboxSessions",
  "deleteChatbox",
  "selectModel",
  "setSystemPrompt",
  "resetChat",
  "stopGeneration",
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

/**
 * Hosts-screen commands, handled by `HostsTab` while `/hosts` (or the
 * `/servers` hub it also wraps) is mounted.
 *
 * A host is addressed by name or id as the host list shows it; handlers
 * resolve it against the loaded host list and reject anything else as
 * `invalid_request` (ambiguous → ask for the id) — never a fuzzy guess.
 *
 * Two deliberate postures mirror the eval/swarm groups:
 * - **Prefill-over-commit for config.** A host config is high-entropy (model,
 *   system prompt, behavior flags, protocol, appearance across focus tabs), so
 *   there is NO one-shot "update host config" command. `openHostEditor` only
 *   navigates the human to the host's editor to change any of that.
 * - **Direct commit for the low-entropy actions.** Creating from a client
 *   TEMPLATE (name + template id), replacing the attached server LIST (existing
 *   project server names), deleting, and duplicating are all low-entropy — the
 *   model can plausibly get the full input right and the user can see it
 *   happen — so they commit directly.
 */

/**
 * Create a host from a client TEMPLATE. Low-entropy: a display name plus the
 * catalog template id (e.g. "claude", "cursor"); `template` defaults to the
 * default catalog host when omitted. The config is seeded from the template
 * exactly as the New Client dialog does — the model never authors arbitrary
 * host config here. The new host is selected and opened.
 */
export interface CreateHostInspectorCommand {
  id: string;
  type: "createHost";
  payload: { name: string; template?: string };
  timeoutMs?: number;
}

/**
 * Navigate the human to a host's editor. The way to change any host CONFIG
 * (model, system prompt, behavior flags, protocol, appearance) — those are
 * high-entropy and live behind the editor's focus tabs, so the agent opens the
 * editor rather than committing config from a chat body.
 */
export interface OpenHostEditorInspectorCommand {
  id: string;
  type: "openHostEditor";
  payload: { host: string };
  timeoutMs?: number;
}

/**
 * Replace a host's attached server set. Low-entropy: a list of EXISTING project
 * server names (the same ones the Connect screen lists). Handlers resolve each
 * name against the project's servers and reject an unknown name as
 * `invalid_request` — the whole call is refused rather than partially applied.
 * Set-to-list, so a retry converges rather than accumulating.
 */
export interface SetHostServersInspectorCommand {
  id: string;
  type: "setHostServers";
  payload: { host: string; servers: string[] };
  timeoutMs?: number;
}

/** Permanently delete a host, including its config and sessions. */
export interface DeleteHostInspectorCommand {
  id: string;
  type: "deleteHost";
  payload: { host: string };
  timeoutMs?: number;
}

/**
 * Duplicate a host. Low-entropy (a source host + an optional new name); the
 * copy is selected and opened.
 */
export interface DuplicateHostInspectorCommand {
  id: string;
  type: "duplicateHost";
  payload: { host: string; name?: string };
  timeoutMs?: number;
}

/**
 * Computer-screen commands, handled by `ComputerView` while `/computer` is
 * mounted. Every command acts on the caller's ONE computer for the currently
 * selected project — there is no target in the payload (the project is resolved
 * from the surface, never from the agent), so each carries an empty payload.
 *
 * The handlers call the SAME gated action hooks the buttons use and respect the
 * SAME availability + billing gates:
 * - Computers unavailable here (no data plane / not signed into a project) ⇒
 *   `unsupported_in_mode` — the tools are inert exactly where the buttons are.
 * - The daily start cap is enforced server-side on reserve; `startComputer`
 *   surfaces a cap rejection as `execution_failed` naming the limit, never a
 *   bypass — mirroring the Open-terminal button, which also just reserves and
 *   reports the cap.
 *
 * The interactive TERMINAL is deliberately NOT a command: opening it mints a
 * short-lived token and drops a human into a live shell — not an agent action.
 * The snapshot reports whether a terminal is open, but no tool opens one and no
 * token ever crosses the transcript.
 */

/**
 * Reserve (provision-on-first-use / wake) the project's computer. Billed and
 * daily-cap-gated: this spins/wakes real infra. Does NOT open the interactive
 * terminal.
 */
export interface StartComputerInspectorCommand {
  id: string;
  type: "startComputer";
  payload?: Record<string, never>;
  timeoutMs?: number;
}

/** Manually hibernate the project's computer (pause; state is preserved). */
export interface HibernateComputerInspectorCommand {
  id: string;
  type: "hibernateComputer";
  payload?: Record<string, never>;
  timeoutMs?: number;
}

/** Reset the project's computer to its image — wipes all mutable state. */
export interface ResetComputerInspectorCommand {
  id: string;
  type: "resetComputer";
  payload?: Record<string, never>;
  timeoutMs?: number;
}

/** Tear down the project's computer, deleting all files on it. */
export interface DeleteComputerInspectorCommand {
  id: string;
  type: "deleteComputer";
  payload?: Record<string, never>;
  timeoutMs?: number;
}

/**
 * Chatboxes-screen commands, handled by `ChatboxesTab` while `/chatboxes` is
 * mounted. A chatbox is the shareable publish surface bound 1:1 to a host.
 *
 * Publish and delete are HOST-ANCHORED: `host` is a host name or id as the
 * client picker shows it. Handlers resolve it against the loaded host list and
 * reject anything else as `invalid_request` (ambiguous → ask for the id) — never
 * a fuzzy guess. Two deliberate postures mirror the eval/swarm/host groups:
 * - **The Swarms-owned dead-end.** A standalone Journeys-owned host has NO
 *   publish surface. `publishChatbox` refuses it with `unsupported_in_mode`
 *   carrying the same reason the UI's "Managed by Swarms" notice shows — it
 *   never back-mints a chatbox for such a host.
 * - **Generate SPENDS MONEY.** `generateChatboxSessions` reproduces the
 *   Generate-with-AI dialog's default path (generate personas, then run
 *   synthetic multi-turn sessions) against the on-screen chatbox through the
 *   SAME gated endpoints the dialog uses. It is synthetic-only (the human
 *   Chatbox product refuses it as `unsupported_in_mode`) and requires the
 *   chatbox's client to have a model (the dialog's own gate), else
 *   `execution_failed`.
 *
 * Reviewing sessions and copying the share link are READ-ONLY human actions —
 * exposed in the snapshot, not as commands. The share TOKEN never crosses the
 * transcript (the snapshot reports only "has link").
 */

/**
 * Publish (provision-on-first-use) the chatbox for a host, then select that
 * host so the publish surface follows. Idempotent — calling `ensureChatboxForHost`
 * the way the publish flow does, so a host that already has a chatbox converges.
 * Refuses a Swarms-owned host (no publish surface).
 */
export interface PublishChatboxInspectorCommand {
  id: string;
  type: "publishChatbox";
  payload: { host: string };
  timeoutMs?: number;
}

/**
 * Generate AI personas and run synthetic sessions against the on-screen
 * chatbox. Low-entropy counts only (personaCount / sessionsPerPersona /
 * maxTurns); the backend generates the personas. SPENDS MONEY, so it is
 * destructive (approval pill) and open-world. No target — it acts on the
 * currently-selected chatbox, like the computer commands act on the one
 * computer.
 */
export interface GenerateChatboxSessionsInspectorCommand {
  id: string;
  type: "generateChatboxSessions";
  payload?: {
    personaCount?: number;
    sessionsPerPersona?: number;
    maxTurns?: number;
  };
  timeoutMs?: number;
}

/** Permanently delete a host's chatbox — its hosted link and usage history. */
export interface DeleteChatboxInspectorCommand {
  id: string;
  type: "deleteChatbox";
  payload: { host: string };
  timeoutMs?: number;
}

/**
 * Playground CHAT-composer commands, handled by the Playground surface while
 * `/playground` is mounted. Unlike the mount-scoped surface groups, these
 * EXTEND the always-on global playground catalog (`groups/playground.ts`) —
 * the playground manifest is `kind: "global"`, so its tools auto-open the
 * playground from anywhere. They act on the ONE playground chat session; there
 * is no target in the payload (the session is resolved from the surface, never
 * from the agent).
 *
 * The handlers call the SAME functions the composer controls use (the model
 * picker's onChange, the system-prompt setter, the Clear-chat reset flow, the
 * stop control). Nothing about the transcript crosses the wire: `selectModel`
 * takes a model identifier, not a conversation; `setSystemPrompt` takes the
 * user-directed prompt as an INPUT but the snapshot only reports its
 * presence/length; reset/stop carry no payload.
 */

/**
 * Select the playground chat model. `model` is a model identifier as the
 * picker addresses it (its id, or its display name). Handlers resolve it
 * against the available models and reject anything else as `invalid_request`
 * — never a fuzzy guess.
 */
export interface SelectModelInspectorCommand {
  id: string;
  type: "selectModel";
  payload: { model: string };
  timeoutMs?: number;
}

/**
 * Set the playground chat's system prompt. `prompt` is free text the USER is
 * directing (empty string clears it). It is an INPUT only: the prompt is never
 * echoed back in results or snapshots beyond its presence and length.
 */
export interface SetSystemPromptInspectorCommand {
  id: string;
  type: "setSystemPrompt";
  payload: { prompt: string };
  timeoutMs?: number;
}

/**
 * Start a new / reset the playground chat. Destructive (loses the current
 * conversation) — the agent tool's own approval pill is the confirmation, so
 * this performs the same reset the Clear-chat dialog does directly.
 */
export interface ResetChatInspectorCommand {
  id: string;
  type: "resetChat";
  payload?: Record<string, never>;
  timeoutMs?: number;
}

/** Stop an in-flight playground generation. No-op (success) when idle. */
export interface StopGenerationInspectorCommand {
  id: string;
  type: "stopGeneration";
  payload?: Record<string, never>;
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
  | LaunchSwarmRunInspectorCommand
  | CreateHostInspectorCommand
  | OpenHostEditorInspectorCommand
  | SetHostServersInspectorCommand
  | DeleteHostInspectorCommand
  | DuplicateHostInspectorCommand
  | StartComputerInspectorCommand
  | HibernateComputerInspectorCommand
  | ResetComputerInspectorCommand
  | DeleteComputerInspectorCommand
  | PublishChatboxInspectorCommand
  | GenerateChatboxSessionsInspectorCommand
  | DeleteChatboxInspectorCommand
  | SelectModelInspectorCommand
  | SetSystemPromptInspectorCommand
  | ResetChatInspectorCommand
  | StopGenerationInspectorCommand;

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
