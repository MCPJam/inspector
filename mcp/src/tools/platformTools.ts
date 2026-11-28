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
  startMuseReadinessRunOperation,
  getReadinessRunOperation,
  listReadinessRunsOperation,
  cancelReadinessRunOperation,
  resumeReadinessRunOperation,
  getReadinessReportOperation,
  listDirectoryFlowsOperation,
  getDirectoryFlowOperation,
  createDirectorySubmissionOperation,
  listDirectorySubmissionsOperation,
  getDirectorySubmissionOperation,
  updateDirectorySubmissionOperation,
  deleteDirectorySubmissionOperation,
  startDirectorySubmissionRunOperation,
  getDirectorySubmissionResultsOperation,
  createReviewerAttemptOperation,
  listReviewerAttemptsOperation,
  getReviewerAttemptOperation,
  resumeReviewerAttemptOperation,
  cancelReviewerAttemptOperation,
  getDirectorySubmissionHandoffOperation,
  listDirectorySubmissionFindingsOperation,
  getDirectorySubmissionFindingOperation,
  exportDirectorySubmissionOperation,
  listDirectorySubmissionEventsOperation,
  recordDirectorySubmissionStatusOperation,
  recordDirectorySubmissionSnapshotOperation,
  importDirectoryFindingOperation,
  draftDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionToolTestsOperation,
  saveDirectorySubmissionTestPlanOperation,
  exportDirectorySubmissionTestCasesOperation,
  getDirectorySubmissionEvalsOperation,
  importDirectorySubmissionTestCasesOperation,
  setDirectorySubmissionEvalsOperation,
  startConformanceRunOperation,
  getConformanceRunOperation,
  listConformanceRunsOperation,
  getConformanceReportOperation,
  getConformanceCheckOperation,
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
  importEvalCasesOperation,
  cancelEvalRunOperation,
  backtestEvalRunOperation,
  backtestEvalRunJudgeOperation,
  requestEvalRunJudgeOperation,
  proposeEvalDescriptionRewriteOperation,
  startEvalDescriptionExperimentOperation,
  getEvalDescriptionExperimentOperation,
  listEvalGithubReposOperation,
  connectEvalGithubRepoOperation,
  listEvalCheckReposOperation,
  connectEvalCheckRepoOperation,
  getStudyOperation,
  getEvalCaseOperation,
  getEvalIterationTraceOperation,
  compareEvalRunOperation,
  getEvalGateWaiverOperation,
  getEvalRunOperation,
  getEvalRunStageAnalyticsOperation,
  getEvalRunGateOperation,
  getEvalRunRouteFactsOperation,
  getEvalRunServerFactsOperation,
  listEvalSuiteStageAnalyticsOperation,
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
  listStudiesOperation,
  listChatSessionsOperation,
  searchSessionsOperation,
  sendChatMessageOperation,
  driveChatSessionBrowserOperation,
  observeChatSessionBrowserOperation,
  getChatSessionOperation,
  getChatSessionTraceOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuiteRevisionsOperation,
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
  listServerRevisionsOperation,
  getServerRevisionOperation,
  diffServerRevisionsOperation,
  createMockServerOperation,
  updateMockServerOperation,
  getMockServerOperation,
  patchMockServerOperation,
  refreshMockServerOperation,
  openMockRunOperation,
  resetMockRunOperation,
  closeMockRunOperation,
  getMockForwardingPolicyOperation,
  setMockForwardingPolicyOperation,
  listServerAccountsOperation,
  getServerAccountOperation,
  deleteServerAccountOperation,
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
  listGoalsOperation,
  getGoalOperation,
  createGoalOperation,
  updateGoalOperation,
  archiveGoalOperation,
  generateGoalsOperation,
  listGoalRunsOperation,
  getGoalRunOperation,
  listGoalRunSessionsOperation,
  launchGoalRunOperation,
  cancelGoalRunOperation,
  getSwarmRunOperation,
  listSwarmRunSessionsOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  archiveSwarmOperation,
  getSwarmOverviewOperation,
  getGoalRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getSwarmRunInsightsOperation,
  requestSwarmRunInsightsOperation,
  cancelSwarmRunInsightsOperation,
  requestEvalRunInsightsOperation,
  cancelEvalRunInsightsOperation,
  buildEvalRunFindingsOperation,
  publishStudyOperation,
  unpublishStudyOperation,
  listStudySessionsOperation,
  getStudySessionOperation,
  getStudyMetricsOperation,
  getStudyUsageOperation,
  listStudyFindingsOperation,
  getStudySignalsOperation,
  getStudyInsightsOperation,
  updateStudyOperation,
  requestStudyInsightsOperation,
  cancelStudyInsightsOperation,
  dismissStudyFindingOperation,
  undismissStudyFindingOperation,
  setStudyGuestExecutionOperation,
  rotateStudyLinkOperation,
  upsertStudyMemberOperation,
  removeStudyMemberOperation,
  rebindStudyOperation,
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
  sendFeedbackOperation,
  ALL_OPERATIONS,
  runOperationWithPermalinks,
  withPermalinkEnvelope,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import {
  describeOperationError,
  errorStructuredContent,
  HELD_OPERATION_NAMES,
  HELD_WHILE_IN_BETA,
  MCP_RESULT_PROJECTIONS,
  operationAnnotations,
  operationDescription,
  toolError,
  toolSuccess,
} from "@mcpjam/sdk/internal/mcp-surface";
import { MCPJAM_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import {
  PLATFORM_WIDGETS_ENABLED,
  PLATFORM_WIDGET_RESOURCE_URIS,
  tagPlatformWidgetPayload,
  type PlatformWidgetView,
} from "../shared/platform-widgets.js";
import type { PlatformToolContext } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";
import {
  describeGuestMintFailure,
  guestMintErrorContent,
} from "../guestMint.js";

/**
 * Every operation this catalog carries, in list order — including the held
 * betas, which `PLATFORM_CATALOG_OPERATIONS` filters out.
 */
const CATALOG_OPERATIONS_INCLUDING_HELD: ReadonlyArray<
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
  // Stored history, read without connecting: when a server's tools changed
  // and how. Read-only and confined to MCPJam's own records.
  listServerRevisionsOperation,
  getServerRevisionOperation,
  diffServerRevisionsOperation,
  // MOCK SERVERS. Reads are bounded pages (see get_mock_server), so a mock with
  // hundreds of tools or a very long description stays inside this server's
  // response text budget. The policy write is a workspace admin decision and
  // the agent registry gates it.
  createMockServerOperation,
  updateMockServerOperation,
  getMockServerOperation,
  patchMockServerOperation,
  refreshMockServerOperation,
  openMockRunOperation,
  resetMockRunOperation,
  closeMockRunOperation,
  getMockForwardingPolicyOperation,
  setMockForwardingPolicyOperation,
  // SERVER ACCOUNTS — the reads plus the delete. The upload and the update
  // are in EXCLUDED_FROM_CATALOG; deleting the default while other accounts
  // exist is refused, so the delete never moves runs onto another account.
  listServerAccountsOperation,
  getServerAccountOperation,
  deleteServerAccountOperation,
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
  // Directory readiness: in beta, yet listed for every caller. The backend refuses
  // an organization outside the beta with the reason, and each description says so.
  startClaudeReadinessRunOperation,
  startOpenAIReadinessRunOperation,
  startMuseReadinessRunOperation,
  getReadinessRunOperation,
  listReadinessRunsOperation,
  cancelReadinessRunOperation,
  resumeReadinessRunOperation,
  getReadinessReportOperation,
  listDirectoryFlowsOperation,
  getDirectoryFlowOperation,
  createDirectorySubmissionOperation,
  listDirectorySubmissionsOperation,
  getDirectorySubmissionOperation,
  updateDirectorySubmissionOperation,
  deleteDirectorySubmissionOperation,
  startDirectorySubmissionRunOperation,
  getDirectorySubmissionResultsOperation,
  createReviewerAttemptOperation,
  listReviewerAttemptsOperation,
  getReviewerAttemptOperation,
  resumeReviewerAttemptOperation,
  cancelReviewerAttemptOperation,
  // Resuming a submission from its id, so an agent with only these tools
  // can pick one up, read every finding, export the pack and record what
  // happened in the directory.
  getDirectorySubmissionHandoffOperation,
  listDirectorySubmissionFindingsOperation,
  getDirectorySubmissionFindingOperation,
  exportDirectorySubmissionOperation,
  listDirectorySubmissionEventsOperation,
  recordDirectorySubmissionStatusOperation,
  recordDirectorySubmissionSnapshotOperation,
  importDirectoryFindingOperation,
  getDirectorySubmissionTestPlanOperation,
  draftDirectorySubmissionTestPlanOperation,
  saveDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionToolTestsOperation,
  getDirectorySubmissionEvalsOperation,
  setDirectorySubmissionEvalsOperation,
  importDirectorySubmissionTestCasesOperation,
  exportDirectorySubmissionTestCasesOperation,
  startConformanceRunOperation,
  getConformanceRunOperation,
  listConformanceRunsOperation,
  getConformanceReportOperation,
  getConformanceCheckOperation,
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
  // The suite's settings HISTORY, beside the edit that writes it: "who changed
  // this, and when" is the first question after an unexplained result, and its
  // `revisionNumber` is what makes an `update_eval_suite` a compare-and-set.
  listEvalSuiteRevisionsOperation,
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
  importEvalCasesOperation,
  getEvalRunOperation,
  // The DENOMINATOR half of the chain story, beside the run read that is
  // the numerator half. `get_eval_run` says what one trial did and where it
  // stopped; these say how much of the run was measured at all — and until
  // now nothing outside the web app could ask.
  getEvalRunStageAnalyticsOperation,
  getEvalRunGateOperation,
  getEvalRunRouteFactsOperation,
  getEvalRunServerFactsOperation,
  listEvalSuiteStageAnalyticsOperation,
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
  backtestEvalRunOperation,
  backtestEvalRunJudgeOperation,
  requestEvalRunJudgeOperation,
  // The run page's Analyze button as three steps: build findings, request the
  // analysis, cancel it. Results are read from get_eval_run's `insights`.
  buildEvalRunFindingsOperation,
  requestEvalRunInsightsOperation,
  cancelEvalRunInsightsOperation,
  // The description-rewrite experiment, beside the judge request it most
  // resembles: propose and start are spends with a stated cap, so they carry
  // the same risk metadata the judge request does, and the read closes the
  // loop an agent opened. Both routes are wired now (PR-E3), so the earlier
  // catalog exclusion no longer applies.
  proposeEvalDescriptionRewriteOperation,
  startEvalDescriptionExperimentOperation,
  getEvalDescriptionExperimentOperation,
  listEvalGithubReposOperation,
  connectEvalGithubRepoOperation,
  // The pre-rename spellings of the two above, still advertised so an agent
  // already calling one keeps its tool. `check` in these names is a GITHUB
  // check, never a case's grading check; the new names say so out loud.
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
  listStudiesOperation,
  getStudyOperation,
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
  driveChatSessionBrowserOperation,
  observeChatSessionBrowserOperation,
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
  listGoalsOperation,
  getGoalOperation,
  createGoalOperation,
  updateGoalOperation,
  archiveGoalOperation,
  generateGoalsOperation,
  listGoalRunsOperation,
  getGoalRunOperation,
  listGoalRunSessionsOperation,
  launchGoalRunOperation,
  cancelGoalRunOperation,
  getSwarmRunOperation,
  listSwarmRunSessionsOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  archiveSwarmOperation,
  getSwarmOverviewOperation,
  getGoalRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getSwarmRunInsightsOperation,
  requestSwarmRunInsightsOperation,
  cancelSwarmRunInsightsOperation,
  publishStudyOperation,
  unpublishStudyOperation,
  listStudySessionsOperation,
  getStudySessionOperation,
  getStudyMetricsOperation,
  getStudyUsageOperation,
  listStudyFindingsOperation,
  getStudySignalsOperation,
  getStudyInsightsOperation,
  updateStudyOperation,
  requestStudyInsightsOperation,
  cancelStudyInsightsOperation,
  dismissStudyFindingOperation,
  undismissStudyFindingOperation,
  setStudyGuestExecutionOperation,
  rotateStudyLinkOperation,
  upsertStudyMemberOperation,
  removeStudyMemberOperation,
  rebindStudyOperation,
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
  // Platform feedback: the agent's channel to the MCPJam team at the moment a
  // tool fails or a capability is missing. SENDS TEXT OUTSIDE THE CALLER'S
  // ORGANIZATION, which the description, the `openWorldHint` and the hint
  // below all say.
  sendFeedbackOperation,
];

/** Every catalog operation registered as a tool, in list order. */
export const PLATFORM_CATALOG_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, any>
> = CATALOG_OPERATIONS_INCLUDING_HELD.filter(
  (operation) => !HELD_OPERATION_NAMES.has(operation.name)
);

/** Every SDK operation not exposed by the generic MCP catalog, with policy. */
export const EXCLUDED_FROM_CATALOG: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    HELD_WHILE_IN_BETA.flatMap(({ feature, operations }) =>
      operations.map((operation) => [
        operation.name,
        `Held while ${feature} is in beta. This catalog is one static list for every caller, so it would offer the tool to organizations that cannot use it; it returns when the tool list is resolved per caller.`,
      ])
    )
  ),
  show_servers: "Registered by the dedicated show_servers MCP Apps tool.",
  create_reviewer_handoff:
    "Returns a single-use browser sign-in link that should stay with the requester. Generate it in Readiness or through a direct API or CLI call so it stays out of the MCP host transcript.",
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
  // rotate is already `rotate_study_link`. The I5 operations span three
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
    "Scenario share already appears on get_study. The unified read also covers conformance and eval runs; bind all three resource types together when this catalog grows a share group.",
  set_share_mode:
    "Scenario exposure is already update_study. The unified setter also changes who can open a conformance or eval share URL; shipping it now would add a second spelling of scenario mode on the unattended catalog.",
  rotate_share_link:
    "Scenario rotation is already rotate_study_link. The unified rotate is destructive across resource types and should land with the same share group as the get/set pair, not as a third rotate tool.",
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
  // SERVER ACCOUNT WRITES. The upload on create_secret's argument: the token
  // is an input. The update because the default decides which account runs
  // with no saved account choice sign in as, which is not an unattended
  // caller's choice.
  upload_server_account_tokens:
    "The access token is an argument, so it would transit model context and be written into chat transcripts before any approval could run. Available on REST, the SDK and the CLI, where the caller controls where the token comes from. The reads (list_server_accounts, get_server_account) are in the catalog.",
  update_server_account:
    "Making an account the default decides which account runs with no saved account choice sign in as, and a rename changes which account a name addresses. Available on REST, the SDK and the CLI, for a person who means it.",
  // TRACE DESTINATIONS. The two credential writes are excluded on exactly the
  // `create_secret` argument above: the vendor headers are arguments, so they
  // would transit model context and be written into chat transcripts before
  // any approval card could render.
  //
  // The other eight — including the three metadata READS, which is where this
  // departs from the secrets precedent — are excluded because the whole
  // surface is organization administration whose effects land in a third
  // party's system. A catalog that could read an organization's vendor
  // bindings but not act on them would be an admin console with the buttons
  // removed; the Observability section in organization settings is the view,
  // and REST/SDK/CLI are the programmatic route.
  create_trace_destination:
    "The vendor credentials are arguments, so they would transit model context and be written into chat transcripts before any approval could run. Available on REST, the SDK and the CLI, where the caller controls where the values come from.",
  update_trace_destination:
    "Same as create_trace_destination: rotating a credential carries it as an argument, with the same pre-approval exposure. Available on REST, the SDK and the CLI.",
  delete_trace_destination:
    "Discards a live export and its stored credentials, and cannot retract what has already been delivered to the vendor. An organization-admin decision, available on REST, the SDK and the CLI.",
  pause_trace_destination:
    "Nothing is queued while a destination is paused, so an unattended pause becomes a permanent gap in a customer's observability. Available on REST, the SDK and the CLI.",
  resume_trace_destination:
    "Restarts an export a human stopped, usually because something about it was wrong. Whether the cause is fixed is a judgement about a third party's system. Available on REST, the SDK and the CLI.",
  test_trace_destination:
    "An outbound call to a third party's intake on the organization's credentials. Available on REST, the SDK and the CLI.",
  backfill_trace_destination:
    "Can queue a month of an organization's history at a vendor that bills on ingest. Available on REST, the SDK and the CLI.",
  list_trace_destinations:
    "Organization observability configuration — an admin surface, not a catalog one. Available on REST, the SDK and the CLI.",
  get_trace_destination:
    "Same as list_trace_destinations: admin configuration. Available on REST, the SDK and the CLI.",
  list_trace_destination_backfills:
    "Operational detail for an admin diagnosing an export. Available on REST, the SDK and the CLI.",
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
// A held operation must be one the catalog would otherwise register; holding
// anything else would leave its real exclusion reason unwritten.
const orderedOperationNames = new Set(
  CATALOG_OPERATIONS_INCLUDING_HELD.map((operation) => operation.name)
);
const strayHeldOperations = [...HELD_OPERATION_NAMES].filter(
  (name) => !orderedOperationNames.has(name)
);
if (
  staleCatalogExclusions.length > 0 ||
  uncoveredCatalogOperations.length > 0 ||
  strayHeldOperations.length > 0
) {
  throw new Error(
    `Platform MCP catalog partition drift: stale=${staleCatalogExclusions.join(
      ","
    )}; uncovered=${uncoveredCatalogOperations
      .map((operation) => operation.name)
      .join(",")}; heldOutsideCatalog=${strayHeldOperations.join(",")}`
  );
}

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
  [listStudiesOperation.name]: "scenarios",
  [getStudyOperation.name]: "scenario",
};

export function registerPlatformCatalogTools(
  registrar: SessionToolRegistrar,
  context: PlatformToolContext
): void {
  for (const operation of PLATFORM_CATALOG_OPERATIONS) {
    // `PLATFORM_WIDGETS_ENABLED` off ⇒ no view, so every tool takes the plain
    // branch below and registers with no UI resource and no tagged payload.
    const view = PLATFORM_WIDGETS_ENABLED
      ? PLATFORM_TOOL_WIDGET_VIEWS[operation.name]
      : undefined;
    registrar.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operationDescription(operation),
        inputSchema: operation.inputSchema,
        annotations: operationAnnotations(operation),
      },
      async (input) =>
        runPlatformOperation(
          context,
          operation,
          input,
          MCP_RESULT_PROJECTIONS[operation.name]
        ),
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

export async function runPlatformOperation<TInput, TOutput extends object>(
  context: PlatformToolContext,
  operation: PlatformOperation<TInput, TOutput>,
  input: TInput,
  transformPayload?: (payload: TOutput) => object
) {
  // Resolve the bearer: the verified token for an authed session, or a
  // lazily-minted guest token for an anonymous one. Minting happens here (on
  // first tool execution), never at connect/list_tools.
  const bearer = await context.getBearerToken();
  if (!bearer.ok) {
    context.onGuestMintFailed?.();
    return toolError(
      describeGuestMintFailure(bearer.failure),
      guestMintErrorContent(bearer.failure)
    );
  }
  const token = bearer.token;

  const client = new PlatformApiClient({
    baseUrl: context.runtimeEnv.PLATFORM_API_URL,
    getAuth: () => token,
    userAgent: "mcpjam-mcp-worker/0.2.0",
    // Declared on every eval-run launch this call may make, so a run started
    // by an agent reads as MCP rather than as the generic API badge every
    // hosted launch used to show. `client` names WHICH agent, when the request
    // said: its own `clientInfo.name` when this request carries one, else its
    // user-agent (see `PlatformToolContext.callerUserAgent`).
    //
    // Set on the CLIENT rather than on the operation's input, deliberately: an
    // operation's `inputSchema` is exposed verbatim as the MCP tool's own
    // input, so a launcher field there would let the agent whose run it is
    // choose its own badge.
    launcher: {
      kind: "mcp",
      ...((context.callerClientName ?? context.callerUserAgent)
        ? { client: context.callerClientName ?? context.callerUserAgent }
        : {}),
    },
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
