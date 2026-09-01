/**
 * MCP tools over the shared platform operation catalog. Each tool is a thin
 * adapter: parse args with the operation's schema, call the Platform API
 * with the request's bearer token, and emit the payload as both text and
 * structured content. Operations listed in `PLATFORM_TOOL_WIDGET_VIEWS`
 * additionally register the shared MCP Apps bundle as their UI resource. The
 * widget-backed `show_servers` tool lives in `showServers.ts` and reuses the
 * helpers here.
 */
import {
  callServerToolOperation,
  renderServerWidgetOperation,
  checkHostCompatibilityOperation,
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
  connectProjectServerOperation,
  createEvalCaseOperation,
  createEvalCasesOperation,
  createEvalSuiteOperation,
  createProjectServerOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  diagnoseServerOperation,
  getMeOperation,
  listModelsOperation,
  listOrganizationsOperation,
  createProjectOperation,
  updateProjectOperation,
  generateEvalCasesOperation,
  cancelEvalRunOperation,
  requestEvalRunJudgeOperation,
  listEvalCheckReposOperation,
  connectEvalCheckRepoOperation,
  getScenarioOperation,
  getEvalCaseOperation,
  getEvalIterationTraceOperation,
  compareEvalRunOperation,
  getEvalGateWaiverOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getEvalRunDisclosureOperation,
  getEvalSuiteOperation,
  getEnvironmentOperation,
  ensureAdhocEnvironmentOperation,
  getPluginVersionOperation,
  getProjectServerConnectionStatusOperation,
  cancelProjectServerConnectionOperation,
  getProjectServerOperation,
  getServerPromptOperation,
  isPlatformApiError,
  listScenariosOperation,
  listChatSessionsOperation,
  searchSessionsOperation,
  sendChatMessageOperation,
  getChatSessionOperation,
  getChatSessionTraceOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listImagesOperation,
  getImageOperation,
  listEnvironmentsOperation,
  listProjectPluginsOperation,
  listProjectSkillsOperation,
  getProjectSkillOperation,
  listProjectsOperation,
  listProjectServersOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  PlatformApiClient,
  readServerResourceOperation,
  listServerSkillsOperation,
  getServerSkillOperation,
  readServerSkillFileOperation,
  resolveEnvironmentOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  setEvalSuiteScheduleOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  deleteProjectOperation,
  getCapabilitiesOperation,
  listPersonasOperation,
  getPersonaOperation,
  createPersonaOperation,
  updatePersonaOperation,
  deletePersonaOperation,
  listSecretsOperation,
  getSecretOperation,
  deleteSecretOperation,
  generatePersonasOperation,
  listJourneysOperation,
  getJourneyOperation,
  createJourneyOperation,
  updateJourneyOperation,
  archiveJourneyOperation,
  generateJourneysOperation,
  listJourneyRunsOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  launchJourneyRunOperation,
  cancelJourneyRunOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  archiveSwarmOperation,
  getSwarmOverviewOperation,
  getJourneyRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getWaveInsightsOperation,
  requestWaveInsightsOperation,
  cancelWaveInsightsOperation,
  publishScenarioOperation,
  unpublishScenarioOperation,
  getUserTestingScenarioOperation,
  listUserTestingSessionsOperation,
  getUserTestingSessionOperation,
  getUserTestingMetricsOperation,
  getUserTestingUsageOperation,
  listUserTestingFindingsOperation,
  getUserTestingSignalsOperation,
  getUserTestingInsightsOperation,
  updateUserTestingScenarioOperation,
  requestUserTestingInsightsOperation,
  cancelUserTestingInsightsOperation,
  dismissUserTestingFindingOperation,
  undismissUserTestingFindingOperation,
  setUserTestingGuestExecutionOperation,
  rotateUserTestingLinkOperation,
  upsertUserTestingMemberOperation,
  removeUserTestingMemberOperation,
  rebindUserTestingScenarioOperation,
  listClientsOperation,
  getClientOperation,
  createClientOperation,
  updateClientOperation,
  setClientServersOperation,
  duplicateClientOperation,
  searchRegistryDirectoryOperation,
  getRegistryDirectoryServerOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  listRegistryConnectionsOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  uninstallRegistryServerOperation,
  ALL_OPERATIONS,
  formatPermalinkLines,
  runOperationWithPermalinks,
  withPermalinkEnvelope,
  type PlatformOperation,
  type PlatformPermalink,
} from "@mcpjam/sdk/platform";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { MCPJAM_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import {
  PLATFORM_WIDGET_RESOURCE_URIS,
  tagPlatformWidgetPayload,
  type PlatformWidgetView,
} from "../shared/platform-widgets.js";
import type { PlatformToolContext } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

/** Every catalog operation registered as a tool, in list order. */
export const PLATFORM_CATALOG_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, any>
> = [
  getMeOperation,
  listModelsOperation,
  // The organization read exists to make the two operations below usable: an
  // `organizationId` was previously undiscoverable from any machine surface.
  listOrganizationsOperation,
  listProjectsOperation,
  // Project create/update are HERE, alongside the list, and the industry norm
  // is why. A survey of 16 enterprise MCP servers found container creation is
  // mainstream — GitHub ships `create_repository`, Sentry `create_project` and
  // `update_project`, as do Linear, Supabase, Asana and Monday — while DELETE
  // of a top-level container is near-universally withheld (GitHub omits
  // `delete_repository` deliberately). Excluding create/update was stricter
  // than what those servers ship, for no benefit a caller could see: both are
  // cheap, both are visible in the UI immediately, and neither destroys
  // anything. `delete_project` stays excluded below — that is the line.
  createProjectOperation,
  updateProjectOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  // Connecting a server is on the unattended surface deliberately: the flow
  // cannot complete without a person at a browser, so the most an MCP host can
  // do with it is produce a private link for the requester to open.
  connectProjectServerOperation,
  getProjectServerConnectionStatusOperation,
  cancelProjectServerConnectionOperation,
  diagnoseServerOperation,
  listServerToolsOperation,
  callServerToolOperation,
  renderServerWidgetOperation,
  listServerPromptsOperation,
  getServerPromptOperation,
  listServerResourcesOperation,
  readServerResourceOperation,
  listServerSkillsOperation,
  getServerSkillOperation,
  readServerSkillFileOperation,
  checkHostCompatibilityOperation,
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
  runEvalCaseOperation,
  runEvalSuiteOperation,
  createEvalSuiteOperation,
  getEvalSuiteOperation,
  // What a suite run would disclose (models called and where they route,
  // which analyzers/judges can fire, retention/region) — a planning read for
  // an unattended agent to check, or show a human, BEFORE it launches.
  // `run_eval_suite` already fetches and returns this itself; this tool is
  // for asking ahead of that decision, same rationale as `get_capabilities`.
  getEvalRunDisclosureOperation,
  updateEvalSuiteOperation,
  deleteEvalSuiteOperation,
  setEvalSuiteScheduleOperation,
  setEvalSuiteEnvironmentsOperation,
  listEvalCasesOperation,
  getEvalCaseOperation,
  createEvalCaseOperation,
  createEvalCasesOperation,
  updateEvalCaseOperation,
  deleteEvalCaseOperation,
  generateEvalCasesOperation,
  getEvalRunOperation,
  compareEvalRunOperation,
  // The waiver READ, beside the run read it explains. `get_eval_run` already
  // carries `gateWaiver`, so withholding the dedicated read would hide nothing
  // while making the surface incoherent — and a waiver an unattended reader
  // cannot see is not the visible waiver the workflow exists to produce.
  getEvalGateWaiverOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  getEvalRunStepsOperation,
  cancelEvalRunOperation,
  requestEvalRunJudgeOperation,
  listEvalCheckReposOperation,
  connectEvalCheckRepoOperation,
  listEnvironmentsOperation,
  getEnvironmentOperation,
  resolveEnvironmentOperation,
  // Compose-to-run. Already tier-"direct" in-app; the catalog withheld it
  // because `run_eval_suite`'s `compose` mints the same row. Exposing it
  // lets a caller pin a cell (then `name_environment`, or hand the id to
  // `set_eval_suite_environments`) without launching.
  ensureAdhocEnvironmentOperation,
  // Sandbox image READS. They are the picker behind `update_eval_suite`'s
  // `environment.computerEnvironment`: without them an agent can set a
  // suite's computer image but never enumerate the choices.
  listImagesOperation,
  getImageOperation,
  // Agent Plugins: the READ half only. Every plugin write (import, activate,
  // enable/disable, uninstall) stays off this unattended surface by policy —
  // there is no excluded write operation to list because the SDK ships none.
  listProjectPluginsOperation,
  getPluginVersionOperation,
  // Cloud Skills: the READ half only, same policy as plugins — authoring is an
  // app flow behind a beta gate and the SDK ships no skill write. These are
  // here because skill IDs are load-bearing on this very catalog
  // (set_eval_suite_environments, run_eval_suite's composed stacks), and an
  // agent that cannot list them cannot use the tools that demand them.
  listProjectSkillsOperation,
  getProjectSkillOperation,
  listScenariosOperation,
  getScenarioOperation,
  listChatSessionsOperation,
  searchSessionsOperation,
  // Agent Playground: drive a conversation against a project's MCP servers
  // and read the telemetry it produced. `send_chat_message` SPENDS, and is
  // advertised anyway — this is the one surface where a model debugging its
  // own server can close the loop (send, read the trace, fix, resend), and an
  // MCP client already gates a non-read tool through its own approval.
  //
  // The two reads are here while `list_chat_sessions`/`search_sessions`
  // remain deliberately narrow elsewhere, because taking an id the caller
  // produced is not the same claim as enumerating an org's conversations.
  sendChatMessageOperation,
  getChatSessionOperation,
  getChatSessionTraceOperation,

  // ── Swarms and user testing ─────────────────────────────────────────────
  //
  // Advertised to EVERY caller, including organizations without the
  // `sandboxes-enabled` beta, and that is a deliberate trade rather than an
  // oversight. This catalog is static — one tool list, built with no
  // organization in hand — so the alternative to advertising a beta is not
  // advertising it selectively, it is not advertising it at all. That is what
  // used to happen, and it meant an agent working for a flagged org had no
  // tools for a product the org had paid attention to.
  //
  // What an unflagged caller gets instead is a clean FEATURE_UNAVAILABLE from
  // the write, with a real message. The CLI reached this conclusion first
  // (`cli/src/lib/op-bindings.ts`): a command that answers "not available for
  // your organization" is a better answer than a command that does not exist.
  //
  // `get_capabilities` is what makes it survivable in practice. An agent can
  // ask what it may do here BEFORE it plans, instead of discovering the gate
  // halfway through a task it has already described to someone.
  getCapabilitiesOperation,
  listPersonasOperation,
  getPersonaOperation,
  createPersonaOperation,
  updatePersonaOperation,
  deletePersonaOperation,
  // PROJECT SECRETS — the metadata reads plus the revoke. The two write ops
  // that carry a plaintext are in EXCLUDED_FROM_CATALOG; `delete_secret` is
  // here because revoking a leaked credential is exactly the thing an
  // unattended caller should be able to do without a human in the loop.
  listSecretsOperation,
  getSecretOperation,
  deleteSecretOperation,
  generatePersonasOperation,
  listJourneysOperation,
  getJourneyOperation,
  createJourneyOperation,
  updateJourneyOperation,
  archiveJourneyOperation,
  generateJourneysOperation,
  listJourneyRunsOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  launchJourneyRunOperation,
  cancelJourneyRunOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  archiveSwarmOperation,
  getSwarmOverviewOperation,
  getJourneyRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getWaveInsightsOperation,
  requestWaveInsightsOperation,
  cancelWaveInsightsOperation,
  publishScenarioOperation,
  unpublishScenarioOperation,
  getUserTestingScenarioOperation,
  listUserTestingSessionsOperation,
  getUserTestingSessionOperation,
  getUserTestingMetricsOperation,
  getUserTestingUsageOperation,
  listUserTestingFindingsOperation,
  getUserTestingSignalsOperation,
  getUserTestingInsightsOperation,
  updateUserTestingScenarioOperation,
  requestUserTestingInsightsOperation,
  cancelUserTestingInsightsOperation,
  dismissUserTestingFindingOperation,
  undismissUserTestingFindingOperation,
  setUserTestingGuestExecutionOperation,
  rotateUserTestingLinkOperation,
  upsertUserTestingMemberOperation,
  removeUserTestingMemberOperation,
  rebindUserTestingScenarioOperation,
  // Clients — the product's own primary noun, and until now the one thing an
  // MCP agent could read nowhere and write nowhere. The two reads plus the
  // four bounded writes; `delete_client` stays out (see the exclusion map).
  listClientsOperation,
  getClientOperation,
  createClientOperation,
  updateClientOperation,
  setClientServersOperation,
  duplicateClientOperation,
  searchRegistryDirectoryOperation,
  getRegistryDirectoryServerOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  listRegistryConnectionsOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  uninstallRegistryServerOperation,
];

/** Every SDK operation not exposed by the generic MCP catalog, with policy. */
export const EXCLUDED_FROM_CATALOG: Readonly<Record<string, string>> = {
  show_servers: "Registered by the dedicated show_servers MCP Apps tool.",
  // Its create/update siblings moved INTO the catalog; this reason had to stop
  // being the blanket one they shared, because that rationale is no longer
  // true of project lifecycle as a category. What is true of delete
  // specifically: it cascades across every project-owned resource — servers,
  // credentials, suites, runs, hosts — and nothing on this surface can undo
  // it. Every enterprise MCP server surveyed draws the same line (GitHub ships
  // `create_repository` and omits `delete_repository`). Deleting stays on REST
  // and the CLI, for humans who mean it.
  delete_project:
    "Deleting a project cascades across every project-owned resource and cannot be undone; industry MCP servers ship container create but not delete. Available on REST and the CLI for humans who mean it.",
  validate_server:
    "Server validation is available through the dedicated server diagnostics surface.",
  export_server:
    "Server export is available through the dedicated server diagnostics surface.",
  // The two READS moved INTO the catalog. The "lifecycle" rationale below is
  // about builds and promotions — it never fit a listing and a detail read,
  // and while it covered them an MCP agent could pin a suite's computer image
  // (`update_eval_suite`) with no way to see which images exist. The
  // exclusions that remain say "lifecycle WRITES", so the distinction survives
  // the next person reading this map.
  validate_sandbox_image_blueprint:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface; blueprint linting belongs with the authoring flow that produces one.",
  list_sandbox_image_builds:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface, and a build log is only useful next to the build that produced it.",
  create_tunnel:
    "Tunnel lifecycle is exposed through the dedicated CLI and tunnel surface.",
  close_tunnel:
    "Tunnel lifecycle is exposed through the dedicated CLI and tunnel surface.",
  // The six other client operations moved INTO the catalog. The line that used
  // to run through this whole group — "infrastructure writes are not offered
  // here" — did not survive the question it was asked: editing a client is the
  // product's own primary noun, and the surfaces an agent lives on were the
  // only ones that could not touch it. The line that replaced it is bounded,
  // preconditioned OVERWRITE versus RESOURCE REMOVAL. An overwrite names
  // exactly what it replaces, is refused outright if the client changed since
  // the caller read it, and leaves the client itself standing. Deletion does
  // none of that: it removes the identity every environment, journey and suite
  // points at, and nothing on this surface can put it back.
  //
  // Honest annotations are what make that line hold: `update_client` and
  // `set_client_servers` are `risk: "destructive"` and advertise
  // `destructiveHint: true`, because they replace settings that are currently
  // in force. They are visible anyway, behind compare-and-set.
  delete_client:
    "Deleting a client removes the identity environments, journeys and eval suites point at, and nothing on this surface can restore it. The edit operations are here because a preconditioned overwrite names what it replaces and leaves the client standing; a removal does neither. Available on REST and the CLI for humans who mean it.",
  get_project_environment_capabilities:
    "A deployment-compatibility probe, not an action: it answers whether this platform accepts an environment model override, which the write paths already ask on the caller's behalf.",
  create_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  name_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface. Promotion turns a throwaway into a permanent entry in the project's environment list, which is exactly the kind of durable edit an unattended caller should not make on its own.",
  update_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  archive_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  restore_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  create_sandbox_image:
    "Sandbox image lifecycle WRITES are not offered on the unattended catalog surface. The reads (list_sandbox_images, get_sandbox_image) are in the catalog.",
  update_sandbox_image:
    "Sandbox image lifecycle WRITES are not offered on the unattended catalog surface. The reads (list_sandbox_images, get_sandbox_image) are in the catalog.",
  build_sandbox_image:
    "Sandbox image lifecycle WRITES are not offered on the unattended catalog surface. The reads (list_sandbox_images, get_sandbox_image) are in the catalog.",
  promote_sandbox_image:
    "Sandbox image lifecycle WRITES are not offered on the unattended catalog surface. The reads (list_sandbox_images, get_sandbox_image) are in the catalog.",
  use_sandbox_image:
    "Sandbox image lifecycle WRITES are not offered on the unattended catalog surface. The reads (list_sandbox_images, get_sandbox_image) are in the catalog.",
  reset_computer:
    "Computer lifecycle writes are not offered on the unattended catalog surface.",
  delete_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
  // Unified share (scenarios, conformance runs, eval runs). Scenario-specific
  // rotate is already `rotate_user_testing_link`. The I5 operations span three
  // resource types and belong with the Share dialog / agent-op registry until
  // this catalog grows a dedicated share group — same decision as CLI
  // `op-bindings.ts`.
  // The gate-waiver WRITES. Not excluded for being writes — this catalog
  // carries cancel_eval_run, request_eval_run_judge and the case writes — but
  // for being GOVERNANCE. Waiving overrides a human release decision, and the
  // platform makes it manage-tier with no creator hatch precisely so whoever
  // ran the failing evals cannot wave their own run through. An unattended
  // caller granting itself that override is the same hole with a longer path
  // to it, and the charter's "authorized actor" clause is what it defeats. It
  // also publishes unredacted free text that outlives the waiver.
  waive_eval_gate:
    "Overriding a release gate is a governance act reserved to the manage tier, with no creator hatch, so an unattended caller must not be able to grant itself one. The waiver READ (get_eval_gate_waiver) is in the catalog.",
  revoke_eval_gate_waiver:
    "The other half of the same decision: revoking re-blocks a release somebody else deliberately unblocked. Offered on the attended agent surface behind an approval, not here.",
  get_share_settings:
    "Scenario share already appears on get_user_testing_scenario. The unified read also covers conformance and eval runs; bind all three resource types together when this catalog grows a share group.",
  set_share_mode:
    "Scenario exposure is already update_user_testing_scenario. The unified setter also changes who can open a conformance or eval share URL; shipping it now would add a second spelling of scenario mode on the unattended catalog.",
  rotate_share_link:
    "Scenario rotation is already rotate_user_testing_link. The unified rotate is destructive across resource types and should land with the same share group as the get/set pair, not as a third rotate tool.",
  // PROJECT SECRET WRITES. Excluded for a reason that has nothing to do with
  // how destructive they are, and everything to do with their INPUT: the
  // plaintext credential is an argument, so it would transit model context and
  // be written into chat transcripts before any approval card could render.
  // An approval that runs after the value has already been logged is not an
  // approval. The reads (list_secrets, get_secret) are in the catalog — they
  // return metadata only and cannot produce a value.
  create_secret:
    "The plaintext value is an argument, so it would transit model context and be written into chat transcripts before any approval could run — an approval that fires after the credential is already logged is not one. Available on REST, the SDK and the CLI, where the caller controls where the value comes from. The metadata reads (list_secrets, get_secret) are in the catalog.",
  update_secret:
    "Same as create_secret: a rotation carries the new plaintext as an argument, so it would reach model context and the transcript before any approval could run. Available on REST, the SDK and the CLI. The metadata reads (list_secrets, get_secret) are in the catalog.",
};

const catalogOperationNames = new Set(
  PLATFORM_CATALOG_OPERATIONS.map((operation) => operation.name)
);
const allOperationNames = new Set(
  ALL_OPERATIONS.map((operation) => operation.name)
);
const staleCatalogExclusions = Object.keys(EXCLUDED_FROM_CATALOG).filter(
  (name) => !allOperationNames.has(name)
);
const uncoveredCatalogOperations = ALL_OPERATIONS.filter(
  (operation) =>
    !catalogOperationNames.has(operation.name) &&
    !Object.prototype.hasOwnProperty.call(EXCLUDED_FROM_CATALOG, operation.name)
);
if (
  staleCatalogExclusions.length > 0 ||
  uncoveredCatalogOperations.length > 0
) {
  throw new Error(
    `Platform MCP catalog partition drift: stale=${staleCatalogExclusions.join(
      ","
    )}; uncovered=${uncoveredCatalogOperations
      .map((operation) => operation.name)
      .join(",")}`
  );
}

/**
 * Operations that REMOVE OR INVALIDATE something that already existed, DERIVED
 * from the catalog's own `risk` metadata rather than listed here. They
 * advertise an explicit `destructiveHint: true`, unlike `mayBeDestructive`
 * operations, whose effects are merely unknowable to us.
 *
 * Not only permanent deletion — that was the whole membership when this
 * comment was written, and it stopped being true when `update_client` and
 * `set_client_servers` joined. The taxonomy in the SDK's `risk` field says
 * "removes or invalidates something that existed", and a deterministic
 * OVERWRITE qualifies: replacing a live setting invalidates the one that was
 * in force, and a replacement server list detaches every server it omits.
 * Those two are idempotent (unlike a soft delete, applying the same edit twice
 * does not compound) and they remain in the catalog behind compare-and-set;
 * what stays OUT is resource removal, which no precondition makes
 * recoverable.
 *
 * Deriving is the whole point of that field: it exists so five surfaces make
 * one decision from one place instead of each re-deriving it, and a hand-kept
 * copy here reinstates exactly the drift it was added to remove — the next
 * operation shipped with `risk: "destructive"` and forgotten in this list would
 * silently advertise `destructiveHint: false`.
 *
 * `LEGACY_DESTRUCTIVE_NAMES` covers the operations that predate `risk`. It
 * shrinks to nothing as those are backfilled; it does not grow.
 */
const LEGACY_DESTRUCTIVE_NAMES: ReadonlySet<string> = new Set([
  deleteEvalSuiteOperation.name,
  deleteEvalCaseOperation.name,
  deleteProjectServerOperation.name,
  deleteProjectOperation.name,
  // Cancelling a run terminates in-flight work — state-changing, so clients
  // should be able to confirm before it fires.
  cancelEvalRunOperation.name,
]);

const DESTRUCTIVE_OPERATION_NAMES: ReadonlySet<string> = new Set(
  ALL_OPERATIONS.filter(
    (operation) =>
      operation.risk === "destructive" ||
      LEGACY_DESTRUCTIVE_NAMES.has(operation.name)
  ).map((operation) => operation.name)
);

/**
 * Destructive operations a client must NOT auto-retry.
 *
 * `idempotentHint: true` is a promise that repeating the call is safe after a
 * dropped response. It is false for both kinds below, in opposite ways: the
 * soft deletes answer not-found on a second call, so an auto-retrying client
 * surfaces a spurious error for work that succeeded; and rotating a share link
 * MINTS A NEW ONE each time, so a retry invalidates the link the first call
 * just handed back.
 */
const NON_IDEMPOTENT_DESTRUCTIVE_NAMES: ReadonlySet<string> = new Set([
  // A widget render EXECUTES the caller's tool first, and nobody can promise
  // that running a third party's tool twice is safe. It reaches this list
  // rather than `call_server_tool`'s absent-hints branch because its
  // `risk: "destructive"` classification takes precedence above — which lands
  // it STRICTER than the bare tool call (explicitly destructive, explicitly
  // not retryable), never looser.
  renderServerWidgetOperation.name,
  deletePersonaOperation.name,
  // A HARD delete of a credential: the row and the ciphertext both go, and a
  // second call cannot find the row to report the same outcome.
  deleteSecretOperation.name,
  archiveJourneyOperation.name,
  archiveSwarmOperation.name,
  removeUserTestingMemberOperation.name,
  rotateUserTestingLinkOperation.name,
]);

/**
 * Non-destructive writes a client MAY safely repeat.
 *
 * The default for this branch is `false`, and for its usual inhabitants that is
 * right: starting a run or creating a suite twice produces two of them, so a
 * client that auto-retried a dropped response would silently double the work.
 *
 * Cancelling is the opposite shape. The backend treats cancelling an
 * already-terminal request as a no-op that returns the row rather than an
 * error, so a repeat after a dropped response lands on exactly the state the
 * first call produced. Declaring that is not a nicety: `idempotentHint: false`
 * tells a client NOT to retry, which on a lost response leaves the request
 * holding one of the owner's connection slots — the precise failure this
 * operation exists to clear.
 *
 * OPT-IN, one name at a time. Idempotency is a promise about a specific
 * handler's behavior, and the honest default for anything not examined is the
 * conservative `false` above.
 */
const IDEMPOTENT_WRITE_NAMES: ReadonlySet<string> = new Set([
  cancelProjectServerConnectionOperation.name,
]);

/**
 * Catalog operations that render as MCP Apps widgets, mapped to their view
 * in the shared UI bundle. The rest stay plain: list_projects and
 * list_project_servers defer to the richer show_servers widget,
 * run_eval_suite / create_eval_suite return receipts the run/suite widgets
 * supersede, and get_eval_iteration_trace / list_chat_sessions are
 * agent-oriented payloads with no visual form. `show_servers` itself
 * registers in `showServers.ts`.
 */
export const PLATFORM_TOOL_WIDGET_VIEWS: Readonly<
  Partial<Record<string, PlatformWidgetView>>
> = {
  [listEvalSuitesOperation.name]: "eval_suites",
  [listEvalSuiteRunsOperation.name]: "eval_suite_runs",
  [getEvalRunOperation.name]: "eval_run",
  [listEvalRunIterationsOperation.name]: "eval_run_iterations",
  [listScenariosOperation.name]: "scenarios",
  [getScenarioOperation.name]: "scenario",
};

export function registerPlatformCatalogTools(
  registrar: SessionToolRegistrar,
  context: PlatformToolContext
): void {
  for (const operation of PLATFORM_CATALOG_OPERATIONS) {
    const view = PLATFORM_TOOL_WIDGET_VIEWS[operation.name];
    registrar.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operationDescription(operation),
        inputSchema: operation.inputSchema,
        annotations: operationAnnotations(operation),
      },
      async (input) => runPlatformOperation(context, operation, input),
      view ? platformWidgetUi(context, operation, view) : undefined
    );
  }
}

/**
 * UI registration for a widget-backed tool: the shared app bundle under the
 * view's own resource URI, and a callback whose payload carries the
 * `widget` tag the bundle routes on. This is the callback a widget-backed
 * tool actually registers; the untagged one passed alongside it is the
 * fallback for tools that declare a UI resource but need no payload tag.
 */
export function platformWidgetUi(
  context: PlatformToolContext,
  operation: PlatformOperation<any, any>,
  view: PlatformWidgetView
) {
  return {
    resourceUri: PLATFORM_WIDGET_RESOURCE_URIS[view],
    html: MCPJAM_APP_HTML,
    resourceName: `${operation.title} UI`,
    resourceMeta: {
      ui: {
        prefersBorder: true,
      },
    },
    callback: async (input: unknown) =>
      runPlatformOperation(context, operation, input, (payload) =>
        tagPlatformWidgetPayload(view, payload)
      ),
  };
}

export function operationAnnotations(
  operation: PlatformOperation<unknown, unknown>
): ToolAnnotations {
  if (operation.readOnly) {
    return { readOnlyHint: true };
  }
  // Known-destructive deletes: announce it explicitly so clients can confirm.
  if (DESTRUCTIVE_OPERATION_NAMES.has(operation.name)) {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      // Only claim idempotent when a repeat is genuinely safe. A soft delete
      // answers not-found on the second call and a link rotation mints a new
      // link, so promising idempotency for those turns a dropped response into
      // either a spurious error or an invalidated link.
      idempotentHint: !NON_IDEMPOTENT_DESTRUCTIVE_NAMES.has(operation.name),
    };
  }
  // Operations whose effects are unknowable upstream (call_server_tool runs
  // arbitrary third-party tools) omit destructive/idempotent hints on
  // purpose: per spec, clients must then assume destructive — the honest
  // claim.
  if (operation.mayBeDestructive) {
    return { readOnlyHint: false };
  }
  // Remaining non-read operations (run_eval_suite, create_eval_suite) create
  // resources but never destroy or overwrite them — and creating twice makes
  // two, so only the names that have been checked claim a safe repeat.
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: IDEMPOTENT_WRITE_NAMES.has(operation.name),
  };
}

/**
 * The spend cue a client shows next to a tool that costs money.
 *
 * Read off the operation's own `risk` facet rather than a hand-kept name list:
 * the catalog already knows which operations spend, and a second list here
 * would go stale the first time an operation is re-classified — silently, and
 * in the direction that omits the warning.
 *
 * MCP has no "this costs money" annotation, so the honest place for it is the
 * DESCRIPTION, which every client renders. `run_eval_suite` can start several
 * paid runs at once, and a user approving a tool call deserves to know that
 * before the call, not from the invoice.
 */
export function operationDescription(
  operation: PlatformOperation<unknown, unknown>
): string {
  return operation.risk === "spend"
    ? `${operation.description} COSTS MONEY: this consumes the organization's credits or configured provider keys.`
    : operation.description;
}

export async function runPlatformOperation<TInput, TOutput extends object>(
  context: PlatformToolContext,
  operation: PlatformOperation<TInput, TOutput>,
  input: TInput,
  transformPayload?: (payload: TOutput) => object
) {
  // Resolve the bearer: the verified token for an authed session, or a
  // lazily-minted guest token for an anonymous one. Minting happens here (on
  // first tool execution), never at connect/list_tools.
  const token = await context.getBearerToken();
  if (!token) {
    return toolError("No bearer token on the request.");
  }

  const client = new PlatformApiClient({
    baseUrl: context.runtimeEnv.PLATFORM_API_URL,
    getAuth: () => token,
    userAgent: "mcpjam-mcp-worker/0.2.0",
  });

  try {
    // Permalinks are derived from the RAW result, before any widget transform
    // reshapes it: a policy reading a tagged widget payload would be reading a
    // shape it was never written against.
    const { result, permalinks } = await runOperationWithPermalinks(
      operation,
      input,
      { client },
      {
        appOrigin: context.runtimeEnv.MCPJAM_APP_ORIGIN,
        // A dropped link is otherwise invisible: derivation never fails the
        // operation, so without this a broken policy or a malformed origin
        // silently removes every permalink and nothing anywhere says so.
        onError: (error, operationName) => {
          console.error(
            `[platform-tools] could not build a permalink for ${operationName}:`,
            error instanceof Error ? error.message : String(error)
          );
        },
      }
    );
    return toolSuccess(
      withPermalinkEnvelope(
        transformPayload ? transformPayload(result) : result,
        permalinks
      ),
      permalinks
    );
  } catch (error) {
    return toolError(
      describeOperationError(error),
      errorStructuredContent(error)
    );
  }
}

// Carry a machine-readable error code into the widget so it can tell an empty
// state (NOT_FOUND: no accessible projects, or a selector that matched nothing)
// apart from a real failure (network, timeout, auth) and render the former
// calmly instead of with the alarming destructive styling. The model/CLI still
// see `isError` plus the human-readable text message.
function errorStructuredContent(
  error: unknown
): Record<string, unknown> | undefined {
  if (isPlatformApiError(error)) {
    return { error: { code: error.code, message: error.message } };
  }
  return undefined;
}

function describeOperationError(error: unknown): string {
  if (isPlatformApiError(error)) {
    // Wire errors keep their stable code for agent retry logic; synthesized
    // client-side errors (status 0) are already self-explanatory messages.
    return error.status > 0 ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// Cap on the model-visible text rendering. Resource reads, tool schemas,
// and doctor reports are unbounded upstream; hosts feed `content` into model
// context, so an uncapped pretty-print can blow a turn's budget. Mirrors the
// inspector workspace built-ins' MODEL_OUTPUT_CAP philosophy (never fail
// over size, degrade to a readable prefix). `structuredContent` stays
// complete — widgets and programmatic consumers read that, not the text.
const MODEL_TEXT_CAP = 24_000;

// ── insights-envelope compaction ─────────────────────────────────────────────
// Runs BEFORE both renderings (text AND structuredContent): the generic text
// cap is a blind character slice, and an insights envelope sliced mid-JSON
// would read as complete while silently missing findings. This compaction is
// deterministic and self-describing — every omission lands in the envelope's
// own `truncation` counters, so a reader can never mistake a compacted
// response for a complete one.
export const MODEL_MAX_FINDINGS = 8;
export const MODEL_MAX_EVIDENCE_PER_FINDING = 2;
export const MODEL_CONTRACT_JSON_CAP = 600;

type EnvelopeLike = {
  schemaVersion: number;
  findings: Array<Record<string, unknown>>;
  truncation: {
    truncated: boolean;
    omittedFindings: number;
    omittedEvidence: number;
    contractTruncated: boolean;
  };
};

function isInsightsEnvelope(value: unknown): value is EnvelopeLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as EnvelopeLike;
  // `typeof null === "object"`, so the truncation check must reject null
  // explicitly: a payload with `truncation: null` would otherwise pass as an
  // envelope and throw while compaction read its counters, turning one
  // malformed field into a failed tool call.
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.findings) &&
    typeof candidate.truncation === "object" &&
    candidate.truncation !== null
  );
}

function compactEnvelope(envelope: EnvelopeLike): EnvelopeLike {
  let omittedEvidence = 0;
  let contractTruncated = false;
  // Findings arrive ready-first from the producer, so a head slice keeps
  // every server-ready finding before any investigation is dropped.
  const kept = envelope.findings.slice(0, MODEL_MAX_FINDINGS).map((finding) => {
    const next = { ...finding };
    const evidence = Array.isArray(finding.evidence)
      ? (finding.evidence as unknown[])
      : [];
    if (evidence.length > MODEL_MAX_EVIDENCE_PER_FINDING) {
      omittedEvidence += evidence.length - MODEL_MAX_EVIDENCE_PER_FINDING;
      next.evidence = evidence.slice(0, MODEL_MAX_EVIDENCE_PER_FINDING);
    }
    const target = finding.target as
      | { currentDefinition?: Record<string, unknown> }
      | undefined;
    const def = target?.currentDefinition;
    if (def) {
      const clipped = { ...def };
      for (const key of ["inputSchemaJson", "outputSchemaJson"] as const) {
        const json = clipped[key];
        if (typeof json === "string" && json.length > MODEL_CONTRACT_JSON_CAP) {
          clipped[key] = json.slice(0, MODEL_CONTRACT_JSON_CAP);
          clipped.truncated = true;
          contractTruncated = true;
        }
      }
      next.target = { ...target, currentDefinition: clipped };
    }
    return next;
  });
  const omittedFindings = envelope.findings.length - kept.length;
  if (omittedFindings === 0 && omittedEvidence === 0 && !contractTruncated) {
    return envelope;
  }
  return {
    ...envelope,
    findings: kept,
    truncation: {
      truncated: true,
      omittedFindings: envelope.truncation.omittedFindings + omittedFindings,
      omittedEvidence: envelope.truncation.omittedEvidence + omittedEvidence,
      contractTruncated:
        envelope.truncation.contractTruncated || contractTruncated,
    },
  };
}

/** Compact every insights envelope found at the payload's top level or one
 * level down (`{ run: { insights } }`, `{ scenario: { insights } }`). */
export function compactInsightsForModel<T extends object>(payload: T): T {
  let changed = false;
  const out: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(out)) {
    if (isInsightsEnvelope(value)) {
      const compacted = compactEnvelope(value);
      if (compacted !== value) {
        out[key] = compacted;
        changed = true;
      }
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      if (isInsightsEnvelope(inner.insights)) {
        const compacted = compactEnvelope(inner.insights);
        if (compacted !== inner.insights) {
          out[key] = { ...inner, insights: compacted };
          changed = true;
        }
      }
    }
  }
  return changed ? (out as T) : payload;
}

/**
 * @param permalinks Rendered as ONE concise line each, above the JSON.
 *
 * Duplicated deliberately, and only here: hosts vary in whether they render
 * `structuredContent` at all, so a permalink that existed only there would be
 * invisible in some clients — and the model is meant to see it and hand it to
 * the user verbatim. The lines lead so they survive the truncation below,
 * which is exactly what a large list result would otherwise cut. The JSON
 * itself is NOT re-scanned for permalinks: the array inside it is the same
 * data, and printing both twice would spend the model's budget on URLs.
 */
function toolSuccess(payload: object, permalinks: PlatformPermalink[] = []) {
  payload = compactInsightsForModel(payload);
  const header = permalinks.length
    ? `${formatPermalinkLines(permalinks)}\n\n`
    : "";
  let text = `${header}${JSON.stringify(payload, null, 2)}`;
  if (text.length > MODEL_TEXT_CAP) {
    text = `${text.slice(0, MODEL_TEXT_CAP)}\n…[truncated ${
      text.length - MODEL_TEXT_CAP
    } chars; the complete payload is in structuredContent]`;
  }
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

function toolError(
  message: string,
  structuredContent?: Record<string, unknown>
) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
