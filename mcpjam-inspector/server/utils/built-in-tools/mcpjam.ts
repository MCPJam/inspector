/**
 * MCPJam workspace built-in tools — the in-product surface of the shared
 * platform operation catalog (`@mcpjam/sdk/platform`).
 *
 * Each tool IS a `PlatformOperation`, adapted per the catalog's design
 * ("defined once and adapted per surface"): name, description, input schema,
 * and execute come from the operation — identical to the MCP worker's tools
 * — so the catalog ids registered in the backend `builtInTools` table are
 * the operation names, unchanged. The operations call the platform's own
 * `/api/v1`; in-app the injected `PlatformApiClient` self-dispatches into
 * this server's Hono app (see routes/web/mcpjam-platform-client.ts), so no
 * forked handler logic and no network hop.
 *
 * The one per-surface adaptation is ambient project scoping: every operation
 * takes an optional `project` selector that defaults to "most recently
 * updated" for external callers with no context. In a chat there IS ambient
 * context, so an omitted `project` defaults to the chat's project instead —
 * an input default, not a schema fork. An explicit `project` still works
 * (the agent may roam; authority is the caller's bearer either way), which
 * is why this is a default rather than a clamp.
 *
 * Approval policy: operations that open a connection to a saved MCP server
 * inherit the host's `requireToolApproval`, mirroring the blanket approval
 * MCP tools get from the orchestration layer. `list_project_servers` is a
 * pure platform read and never needs approval, like `web_search`.
 *
 * `execute` returns `{ error: string }` instead of throwing so the model can
 * relay problems conversationally instead of breaking the turn. Results are
 * capped before they reach model context (`MODEL_OUTPUT_CAP`).
 */
import { tool, type ToolSet } from "ai";
import {
  callServerToolOperation,
  connectProjectServerOperation,
  diagnoseServerOperation,
  getProjectServerConnectionStatusOperation,
  cancelEvalRunOperation,
  requestEvalRunJudgeOperation,
  listEvalCheckReposOperation,
  getScenarioOperation,
  getEvalIterationTraceOperation,
  getEvalRunDisclosureOperation,
  compareEvalRunOperation,
  waiveEvalGateOperation,
  getEvalGateWaiverOperation,
  revokeEvalGateWaiverOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getServerPromptOperation,
  listScenariosOperation,
  listChatSessionsOperation,
  searchSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectsOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  listProjectServersOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  readServerResourceOperation,
  startClaudeReadinessRunOperation,
  startOpenAIReadinessRunOperation,
  getReadinessRunOperation,
  listReadinessRunsOperation,
  cancelReadinessRunOperation,
  getReadinessReportOperation,
  startConformanceRunOperation,
  getConformanceRunOperation,
  listConformanceRunsOperation,
  getConformanceReportOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  getCapabilitiesOperation,
  listPersonasOperation,
  getPersonaOperation,
  createPersonaOperation,
  updatePersonaOperation,
  listJourneysOperation,
  getJourneyOperation,
  createJourneyOperation,
  updateJourneyOperation,
  listJourneyRunsOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  getSwarmOverviewOperation,
  getJourneyRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getWaveInsightsOperation,
  getUserTestingMetricsOperation,
  getUserTestingUsageOperation,
  listUserTestingFindingsOperation,
  getUserTestingSignalsOperation,
  getUserTestingInsightsOperation,
  dismissUserTestingFindingOperation,
  undismissUserTestingFindingOperation,
  searchRegistryDirectoryOperation,
  getRegistryDirectoryServerOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  listRegistryConnectionsOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  uninstallRegistryServerOperation,
  type PlatformApiClient,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";

// The workspace toolset, in advertise order. Mirrors PLATFORM_CATALOG_OPERATIONS
// in mcp/src/tools/platformTools.ts — both surfaces pull from the same SDK
// operations. showServersOperation is intentionally omitted (MCP Apps widget only).
const WORKSPACE_OPERATIONS: ReadonlyArray<PlatformOperation<any, unknown>> = [
  listProjectsOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  // Connecting a server from in-app chat produces a private link the user
  // opens in the same browser they are already signed into.
  connectProjectServerOperation,
  getProjectServerConnectionStatusOperation,
  diagnoseServerOperation,
  listServerToolsOperation,
  callServerToolOperation,
  listServerPromptsOperation,
  getServerPromptOperation,
  listServerResourcesOperation,
  readServerResourceOperation,
  startClaudeReadinessRunOperation,
  startOpenAIReadinessRunOperation,
  getReadinessRunOperation,
  listReadinessRunsOperation,
  cancelReadinessRunOperation,
  getReadinessReportOperation,
  startConformanceRunOperation,
  getConformanceRunOperation,
  listConformanceRunsOperation,
  getConformanceReportOperation,
  listEvalSuitesOperation,
  listEvalSuiteRunsOperation,
  // Read-only, checked BEFORE a launch decision — placed ahead of the two run
  // operations it exists to inform. `run_eval_suite` already fetches and
  // returns its own disclosure on the receipt, so this is for when a caller
  // needs the answer before committing to launch, not after.
  getEvalRunDisclosureOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  getEvalRunOperation,
  compareEvalRunOperation,
  waiveEvalGateOperation,
  getEvalGateWaiverOperation,
  revokeEvalGateWaiverOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  getEvalRunStepsOperation,
  cancelEvalRunOperation,
  requestEvalRunJudgeOperation,
  listEvalCheckReposOperation,
  listScenariosOperation,
  getScenarioOperation,
  listChatSessionsOperation,
  // Advertised with its reach NARROWED rather than excluded: see
  // `WORKSPACE_INPUT_CLAMPS` — scenario (visitor) sessions stay unsearchable
  // here, matching the line the user-testing exclusions below already draw.
  searchSessionsOperation,

  // ── Swarms ──────────────────────────────────────────────────────────────
  //
  // READS and REVERSIBLE AUTHORING. The line this surface draws is not the
  // beta flag and not read-vs-write — it is whether the app has a screen that
  // shows you what you are about to do. Creating a persona in chat is fine:
  // you can see it, edit it, delete it. Launching a run from chat is not, and
  // the Swarms tab is the reason — it puts the journey, its targets and its
  // session count in front of you before anything spends, and a chat tool
  // would start all of it from an id with none of that context.
  //
  // `get_capabilities` leads because the same static-catalog problem applies
  // here: this toolset is compiled in, so it cannot tell the model that this
  // organization is not in the beta.
  getCapabilitiesOperation,
  listPersonasOperation,
  getPersonaOperation,
  createPersonaOperation,
  updatePersonaOperation,
  listJourneysOperation,
  getJourneyOperation,
  createJourneyOperation,
  updateJourneyOperation,
  listJourneyRunsOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  getSwarmOverviewOperation,
  getJourneyRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getWaveInsightsOperation,

  // ── User testing ────────────────────────────────────────────────────────
  //
  // The AGGREGATE reads and the judgement calls over them. Session listings
  // and transcripts are excluded: they are real people's conversations with
  // your product, and a chat tool that can page through them turns an
  // assistant turn into a transcript reader. Same line `list_chat_sessions`
  // already draws. The exposure controls are excluded for the reason the tab
  // exists — the share link and access mode are shown inline there.
  getUserTestingMetricsOperation,
  getUserTestingUsageOperation,
  listUserTestingFindingsOperation,
  getUserTestingSignalsOperation,
  getUserTestingInsightsOperation,
  dismissUserTestingFindingOperation,
  undismissUserTestingFindingOperation,
  searchRegistryDirectoryOperation,
  getRegistryDirectoryServerOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  listRegistryConnectionsOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  uninstallRegistryServerOperation,
];

/**
 * Explicit policy for operations intentionally kept off the in-app chat toolset.
 *
 * WRITTEN OUT, not derived. A map computed as "everything the toolset lacks"
 * makes the partition exact by construction — it can never fail, and every
 * operation added to the SDK arrives here silently pre-excused. Naming each one
 * means advertising it in chat requires deleting a line.
 *
 * Enforced by `__tests__/mcpjam-built-in-tools.test.ts`, not by a module-load
 * throw: a drifted list should fail the build, not refuse to boot the server.
 */
export const EXCLUDED_FROM_WORKSPACE: Readonly<Record<string, string>> = {
  connect_eval_check_repo:
    "Reaches OUTSIDE MCPJam and changes a shared repository for everyone who opens a pull request against it — with fail_closed it can block their merges. The suite settings sheet has this at the point of intent, next to the repository picker and the policy explainer, which is the context the decision needs. Available on the API, the CLI and the gated agent surfaces, where it goes through an approval proposal.",
  launch_journey_run:
    "Launching spends model credits across a whole fan-out. The Swarms tab puts the journey, its targets and its session count in front of you first; a chat tool would start all of it from an id.",
  cancel_journey_run:
    "The Swarms tab has a Stop control with the run in front of you; a chat tool would cancel by id with none of that context.",
  // Swarms authoring writes that REMOVE or SPEND. The reversible half of
  // authoring (create/update persona, journey, swarm) is advertised above —
  // you can see the result in the tab and undo it. These cannot be undone by
  // looking at them.
  delete_persona:
    "Takes a persona off the roster; the Swarms tab shows what still references it before you do.",
  archive_journey:
    "Takes a journey off the roster. The tab shows its run history first, which is the thing you are deciding about.",
  archive_swarm:
    "Takes a container off the roster; the tab shows the journeys authored under it.",
  generate_personas:
    "Runs a model on the organization's account. The create flow in the Swarms tab is where generation belongs — it shows the drafts and lets you pick, where a chat tool would spend and hand back prose.",
  generate_journeys:
    "Same as generate_personas: spends, and the drafts want the picker the tab already has.",
  request_wave_insights:
    "Spends against the organization's shared daily insights budget. The Swarms tab has the button, next to the wave it applies to.",
  cancel_wave_insights:
    "Paired with the request above; offering the cancel without the request is an odd half-surface.",
  // Launches a browser and executes the caller's tool. The Apps tab renders
  // the same widget interactively, with the console and network panes beside
  // it — a chat tool would hand back a verdict with none of that context.
  render_server_widget:
    "The Apps tab renders the widget interactively, with the console and network evidence beside it. Available on REST/CLI/MCP.",
  // Agent Playground. `send_chat_message` runs an assistant turn, and this
  // toolset IS an assistant turn — offering it here lets a chat turn spawn
  // chat turns, which is recursive spend with no natural floor. The two reads
  // follow it out rather than being split off: their only use in chat is to
  // read back a session this toolset cannot create, and the Sessions tab
  // already renders both the transcript and the trace with the context around
  // them.
  send_chat_message:
    "An assistant turn that starts assistant turns — recursive spend with no floor. Available on REST/CLI/MCP, where the caller is not already inside a turn.",
  get_chat_session:
    "Reads back a session this toolset cannot create; the Sessions tab renders the transcript with its context.",
  get_chat_session_trace:
    "Paired with the read above; the Sessions tab renders the same spans in the trace viewer.",
  // Scenarios (user testing).
  publish_scenario:
    "The User Testing tab owns publishing, with the share link and access mode shown inline — a chat tool would hand back a link with none of that context.",
  unpublish_scenario:
    "Takes a live scenario down; the UI confirms it, since guest sessions die with it.",
  // User testing: sessions and transcripts. PRIVACY, not risk — real visitors'
  // conversations, and a chat surface that can page them is a transcript
  // reader wearing an assistant's clothes. Mirrors `list_chat_sessions`.
  list_user_testing_sessions:
    "Visitor conversations; the User Testing tab is where you read them, with the consent context around them.",
  get_user_testing_session:
    "A real person's conversation with your product. Available on REST/CLI/MCP where the caller asked for it explicitly.",
  get_user_testing_scenario:
    "Its actionable-findings envelope quotes visitors verbatim — feedback comments and transcript fragments as evidence — so it falls under the same privacy rule as the session reads above, not the aggregate rule that admits metrics and findings. The User Testing tab renders the same findings with the consent context around them.",
  // Exposure controls. Each of these decides who can reach a live scenario or
  // what it may spend; the tab shows the link, the mode and the current caps
  // next to the control, which a chat tool cannot.
  update_user_testing_scenario:
    "Changing a scenario's access mode belongs next to the share link the tab already shows.",
  set_user_testing_guest_execution:
    "The spend dial for anonymous visitors; the tab shows the current caps and what they have already used.",
  rotate_user_testing_link:
    "Immediate and irreversible — everyone holding the old link loses access. The UI confirms it.",
  rotate_share_link:
    "Immediate and irreversible — everyone holding the old unified share URL loses the ability to redeem it. The UI confirms it.",
  get_share_settings:
    "Share settings belong next to the Share dialog, which already shows the link, mode, and members.",
  set_share_mode:
    "Changing who can open a shared resource belongs next to the share link the UI already shows.",
  upsert_user_testing_member:
    "Granting someone access to a live scenario is a decision about who may talk to your servers.",
  remove_user_testing_member:
    "Paired with the invite above; the member list is the tab's own surface.",
  rebind_user_testing_scenario:
    "Changes what visitors are talking to, under a link they already hold.",
  request_user_testing_insights:
    "Spends against the organization's shared daily insights budget. The tab has the button, next to the window it applies to.",
  cancel_user_testing_insights:
    "Paired with the request above. The wave pair is excluded on the same rule — offering a cancel for a request this surface cannot make is a half-surface, and the tab owns both halves.",

  // Identity and catalogs the surrounding UI already owns. Chat runs inside a
  // chosen project; re-offering the pickers as tools invites the model to
  // wander out of the surface the person is looking at.
  get_me: "The chat surface already knows who is signed in.",
  list_models: "Model choice is the chat UI's own control, not a tool call.",
  list_organizations:
    "Chat runs inside an organization the app shell already names in its switcher; listing the others would only invite the model to reference a scope this window is not in.",

  // Project and org lifecycle. The UI has dedicated flows with confirmations,
  // and these reshape what the rest of the app is showing.
  create_project:
    "Project creation has a dedicated UI flow with its own guardrails.",
  update_project: "Project settings live in the settings surface.",
  delete_project:
    "Irreversible and cascades; the UI requires an explicit confirmation.",

  // Eval AUTHORING. Chat can read evals and run them; composing suites and
  // cases is the Evaluate tab's own editor, which shows validation inline.
  create_eval_suite: "Suite authoring belongs to the Evaluate editor.",
  get_eval_suite: "Covered by list_eval_suites plus the Evaluate tab itself.",
  update_eval_suite: "Suite authoring belongs to the Evaluate editor.",
  delete_eval_suite: "Irreversible delete; the Evaluate tab confirms it.",
  set_eval_suite_schedule:
    "A recurring spend commitment, set deliberately in the UI.",
  set_eval_suite_environments:
    "Attachment changes silently redirect every later run.",
  list_eval_cases: "Case-level browsing is the Evaluate tab's job.",
  get_eval_case: "Case-level browsing is the Evaluate tab's job.",
  create_eval_case: "Case authoring belongs to the Evaluate editor.",
  create_eval_cases: "Case authoring belongs to the Evaluate editor.",
  update_eval_case: "Case authoring belongs to the Evaluate editor.",
  delete_eval_case: "Irreversible delete; the Evaluate tab confirms it.",
  generate_eval_cases:
    "Spends model quota; the Evaluate tab offers it explicitly.",

  // Host and environment administration: re-wires the execution surface.
  list_hosts: "Host administration has its own tab.",
  get_host: "Host administration has its own tab.",
  create_host: "Host creation re-wires the execution surface.",
  update_host: "Host config changes affect every later run.",
  delete_host: "Irreversible and rotates every host config that referenced it.",
  set_host_servers:
    "Re-wiring a host's server set is an administrative action.",
  duplicate_host: "Host administration has its own tab.",
  list_project_environments: "Environments have their own tab.",
  get_project_environment_capabilities:
    "A deployment-compatibility probe, not a user-facing action: it answers whether this platform accepts a model override, which every write path already asks on the caller's behalf.",
  get_project_environment: "Environments have their own tab.",
  resolve_project_environment: "Resolution detail with no chat-facing use.",
  create_project_environment: "Environment authoring has its own editor.",
  ensure_adhoc_environment:
    "Environment authoring has its own editor, and the composer is where a workspace user assembles a stack. The RUN path already carries it: run_eval_suite takes a `compose` object and ensures the environment itself.",
  name_environment:
    "Promoting a composed environment into the project's permanent list is an editor action, and the composer offers it in place.",
  update_project_environment: "Environment authoring has its own editor.",
  archive_project_environment: "Environment lifecycle has its own controls.",
  restore_project_environment: "Environment lifecycle has its own controls.",
  list_project_plugins: "Plugin inventory lives in the Plugins surface.",
  get_plugin_version: "Plugin version detail lives in the Plugins surface.",

  // Sandbox images and computers: minutes-long builds and billable compute.
  list_sandbox_images:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  get_sandbox_image:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  create_sandbox_image:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  update_sandbox_image:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  validate_sandbox_image_blueprint:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  build_sandbox_image:
    "Runs for minutes and bills compute; it cannot complete in a chat turn.",
  list_sandbox_image_builds:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  promote_sandbox_image: "Promotion changes what every later run executes on.",
  use_sandbox_image: "Binding an image to a project is an operator decision.",
  delete_sandbox_image: "Irreversible; image lifecycle is an operator task.",
  reset_computer: "Destroys live sandbox state the person may still be using.",

  // Long-running or connection-opening work a chat turn cannot own.
  check_host_compatibility:
    "Scans a whole catalog; it cannot finish inside a turn.",
  create_tunnel: "Opens a long-lived local process the turn cannot close.",
  close_tunnel: "Tunnel lifecycle belongs to whoever opened it.",
  validate_server:
    "Opens a live connection; diagnose_server covers the chat need.",
  export_server: "Emits a full server config including its auth shape.",
  show_servers:
    "The widget-bearing variant for MCP Apps hosts, not in-app chat.",
};

const OPERATIONS_BY_ID = new Map(
  WORKSPACE_OPERATIONS.map((operation) => [operation.name, operation]),
);

export const MCPJAM_TOOL_IDS: ReadonlyArray<string> = WORKSPACE_OPERATIONS.map(
  (operation) => operation.name,
);

export function isMcpjamToolId(id: string): boolean {
  return OPERATIONS_BY_ID.has(id);
}

// Operations that open an ephemeral connection to a user's saved MCP server
// inherit the host's requireToolApproval. Pure platform API reads (project,
// eval, scenario) never need approval.
const CONNECTION_OPENING_IDS = new Set([
  diagnoseServerOperation.name,
  listServerToolsOperation.name,
  callServerToolOperation.name,
  listServerPromptsOperation.name,
  getServerPromptOperation.name,
  listServerResourcesOperation.name,
  readServerResourceOperation.name,
]);

// Operations that mutate state and therefore require user approval when the
// host enables it — connection-opening tools plus state-changing writes like
// cancelling an in-flight eval run.
const APPROVAL_REQUIRED_IDS = new Set([
  ...CONNECTION_OPENING_IDS,
  cancelEvalRunOperation.name,
  // SPENDS the organization's model budget, on a run the chat can name from
  // a list. Advertised rather than excluded because reading grades is only
  // useful if you can ask for them — but the spend is the user's to approve,
  // so it sits here with `cancel_eval_run` rather than executing on request.
  requestEvalRunJudgeOperation.name,
  // Dials a third party's server for minutes and, with the opt-in, spends the
  // organization's credits. Reading grades is only useful if you can ask for
  // one, so these are advertised rather than excluded — but the asking is the
  // user's to approve. Cancelling is NOT here: it stops that traffic.
  startClaudeReadinessRunOperation.name,
  startOpenAIReadinessRunOperation.name,
  createProjectServerOperation.name,
  updateProjectServerOperation.name,
  deleteProjectServerOperation.name,
  // Belongs with its create/update/delete siblings and then some: the URL is
  // supplied by whoever is talking to the model, this server dials it, and a
  // completed flow adds a server row to the user's project.
  connectProjectServerOperation.name,
  // create_project_server with different spelling: the caller supplies
  // `endpointUrl`, and a completed install adds a server row to the user's
  // project — so it takes the same approval its sibling does.
  installRegistryDirectoryServerOperation.name,
  // Installs a registry card whose config was written by another org member;
  // the completed flow still adds a server row to the user's project.
  installRegistryServerOperation.name,
  // Destructive, same as delete_project_server: removes the installed server
  // row and its connection.
  uninstallRegistryServerOperation.name,
]);

// Surface note appended to each operation's description: in-app, an omitted
// `project` means the chat's project, not the catalog's "most recently
// updated" default for context-free callers.
const AMBIENT_PROJECT_NOTE =
  " When no project is given, the current chat's project is used.";

/**
 * Per-operation input NARROWING for the in-app chat surface.
 *
 * The exclusion list above is all-or-nothing: an operation is advertised in
 * chat or it is not. Some belong here with a smaller reach instead — the whole
 * operation is not the problem, one argument value is. This is the seam for
 * that, and it stays deliberately small: a clamp is a claim that the operation
 * is safe once narrowed, which is a stronger claim than excluding it outright.
 *
 * `transform` returns either the narrowed input or `{ error }`. The two are
 * different answers on purpose. Silently dropping a caller's explicit argument
 * would answer a question they did not ask — the same failure the API's
 * unknown-`sourceType` 400 exists to prevent — so an explicitly forbidden
 * value REFUSES, while an absent one gets a default.
 *
 * `descriptionNote` is appended after `AMBIENT_PROJECT_NOTE` so the model reads
 * the narrowing rather than discovering it by being refused.
 *
 * Enforced by `__tests__/mcpjam-built-in-tools.test.ts`: every key here must be
 * an operation this surface actually advertises, or the clamp is dead code
 * guarding nothing.
 */
type WorkspaceInputClamp = {
  descriptionNote: string;
  transform: (
    input: Record<string, unknown>,
  ) => Record<string, unknown> | { error: string };
};

/** The sourceTypes in-app chat may search. `scenario` is the omission. */
const WORKSPACE_SEARCHABLE_SOURCE_TYPES = ["direct", "eval", "swarm"] as const;

export const WORKSPACE_INPUT_CLAMPS: Readonly<
  Record<string, WorkspaceInputClamp>
> = {
  /**
   * Keep user-testing (`scenario`) transcripts out of in-app chat search.
   *
   * Those are real visitors' conversations with the product, and this surface
   * already draws that line for the listings (`list_user_testing_sessions` and
   * `get_user_testing_session` are both in `EXCLUDED_FROM_WORKSPACE` for
   * visitor privacy). Search would walk straight around it: one query would
   * return visitor titles and transcript previews in a chat turn — MORE of
   * those conversations than the excluded listings expose, not less.
   *
   * The rest of `search_sessions` is genuinely useful in chat ("which session
   * hit that error?"), so the operation is advertised with its reach narrowed
   * rather than removed.
   */
  search_sessions: {
    descriptionNote:
      " In this chat, user-testing (scenario) sessions are not searchable — those are real visitors' conversations. Searches direct, eval, and swarm sessions.",
    transform: (input) => {
      const requested = input.sourceTypes;
      if (
        Array.isArray(requested) &&
        requested.some((value) => value === "scenario")
      ) {
        return {
          error:
            "User-testing (scenario) sessions cannot be searched from chat — those are real visitors' conversations. Search direct, eval, or swarm sessions instead, or use the User Testing tab.",
        };
      }
      // Injected when ABSENT and when EMPTY. `[]` is the dangerous spelling:
      // the zod schema's `.min(1)` rejects it, but `execute()` can be called
      // raw with no schema in the way, and an empty array serializes to no
      // filter at all — which would widen the search to every source,
      // scenario included. Treating `[]` exactly like omission closes that.
      if (!Array.isArray(requested) || requested.length === 0) {
        return {
          ...input,
          sourceTypes: [...WORKSPACE_SEARCHABLE_SOURCE_TYPES],
        };
      }
      return input;
    },
  },
};

export interface McpjamToolOptions {
  /**
   * Platform API client bound to the caller's bearer. In the web chat this
   * self-dispatches into the server's own /api/v1 (no network hop).
   */
  client: PlatformApiClient;
  /** The chat's ambient project — the default when `project` is omitted. */
  projectId: string;
  /** Host's approval policy — connection-opening ops must honor it. */
  requireToolApproval?: boolean;
}

// Cap on serialized result size before it reaches model context. Doctor
// reports and resource contents are unbounded upstream; a tool list with
// large schemas can be too.
const MODEL_OUTPUT_CAP = 24_000;

/**
 * Pass small results through untouched; large ones degrade to a truncated
 * JSON preview the model can still read names out of (same philosophy as
 * bash's stdout cap — never fail the turn over size).
 */
export function capForModel(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { error: "Result could not be serialized." };
  }
  if (json.length <= MODEL_OUTPUT_CAP) return value;
  return {
    truncated: true,
    preview: `${json.slice(0, MODEL_OUTPUT_CAP)}…[truncated ${
      json.length - MODEL_OUTPUT_CAP
    } chars]`,
  };
}

/** Map a thrown error to the `{ error }` envelope, preferring its message. */
export function toToolError(
  error: unknown,
  fallback: string,
): { error: string } {
  const message =
    error instanceof Error && error.message.trim() ? error.message : "";
  return { error: message || fallback };
}

/**
 * Build one workspace tool from its catalog operation. Returns `null` for an
 * id outside the workspace set (the registry warns and skips).
 */
export function buildMcpjamTool(
  id: string,
  opts: McpjamToolOptions,
): ToolSet[string] | null {
  const operation = OPERATIONS_BY_ID.get(id);
  if (!operation) return null;

  const needsApproval =
    APPROVAL_REQUIRED_IDS.has(id) && opts.requireToolApproval === true;

  const clamp = WORKSPACE_INPUT_CLAMPS[id];

  return tool({
    description: `${operation.description}${AMBIENT_PROJECT_NOTE}${
      clamp?.descriptionNote ?? ""
    }`,
    inputSchema: operation.inputSchema,
    needsApproval,
    execute: async (input: Record<string, unknown>, { abortSignal }) => {
      if (abortSignal?.aborted) {
        return { error: `${operation.title} was cancelled.` };
      }
      // Ambient default, not a clamp: an explicit `project` (name or id)
      // wins; only an omitted/blank one resolves to the chat's project.
      // Trimmed here for raw callers — schema-validated input arrives
      // pre-trimmed via zod's .trim().
      const trimmedProject =
        typeof input.project === "string" ? input.project.trim() : "";
      const project = trimmedProject || opts.projectId;

      // AFTER the project default, so a clamp always sees the input the
      // operation will actually run with.
      let clamped: Record<string, unknown> = { ...input, project };
      if (clamp) {
        const result = clamp.transform(clamped);
        // A refusal is a typed result, not a throw: the model should read why
        // it was narrowed and pick another argument, which a thrown error
        // would render as a tool failure instead.
        if ("error" in result && typeof result.error === "string") {
          return { error: result.error };
        }
        clamped = result as Record<string, unknown>;
      }

      try {
        const result = await operation.execute(clamped, {
          client: opts.client,
          signal: abortSignal,
        });
        return capForModel(result);
      } catch (error) {
        if (abortSignal?.aborted) {
          return { error: `${operation.title} was cancelled.` };
        }
        return toToolError(error, `${operation.title} failed.`);
      }
    },
  });
}
