/**
 * Which platform feature each operation belongs to.
 *
 * Some platform features are betas enabled per organization. The backend
 * refuses a gated operation for an organization outside its beta (a `403`
 * whose `details.code` is `FEATURE_UNAVAILABLE`; see `isFeatureUnavailable`).
 * This table is the other half: it lets a surface (the hosted MCP server, the
 * CLI, an agent) advertise only what the caller can use, given the feature
 * availability the platform reports for them.
 *
 * Every operation is listed, the deprecated aliases too, so a new operation
 * cannot ship without someone deciding which feature it belongs to
 * (`tests/platform/features.test.ts` fails until it is listed).
 *
 * One rule overrides the obvious tag. What the backend deliberately leaves
 * open for an organization that lost a feature, so it can still stop, take
 * down or clean up what it started or authored, is never hidden, and neither
 * are the reads needed to find it. Hiding it would leave that organization no
 * advertised way to do so.
 */

/**
 * Feature keys. The backend's gated feature keys (`GatedFeatureKey` in
 * mcpjam-backend `convex/lib/featureGates.ts`), copied by hand, plus the
 * features the platform reports without a server-side gate of that name:
 * `github-checks`, `plugins` and `scheduled-evals`. No operation is hidden by
 * `scheduled-evals`: its one write, `set_eval_suite_schedule`, must stay
 * available so a schedule can always be turned off.
 */
export const PLATFORM_FEATURE_KEYS = [
  "multi-account-connections",
  "local-browser",
  "sandboxes",
  "computers",
  "plugin-extensions",
  "sandbox-images",
  "browser",
  "hosted-browser",
  "skills",
  "environments",
  "claude-code-harness",
  "codex-harness",
  "cursor-harness",
  "org-registry",
  "shared-slack-channel",
  "trace-destinations",
  "grading-engine-mode",
  "description-experiments",
  "conformance",
  "unified-sessions",
  "unified-share-evals",
  "unified-share-conformance",
  "github-checks",
  "plugins",
  "scheduled-evals",
] as const;

export type PlatformFeatureKey = (typeof PLATFORM_FEATURE_KEYS)[number];

/** A short human name for each feature, for help text and messages. */
export const PLATFORM_FEATURES: Readonly<Record<PlatformFeatureKey, string>> = {
  "multi-account-connections": "Multiple accounts for one server",
  "local-browser": "Local Browser",
  sandboxes: "Swarms and studies",
  computers: "Computers",
  "plugin-extensions": "Plugin extensions",
  "sandbox-images": "Sandbox images",
  browser: "Browser",
  "hosted-browser": "Hosted Browser",
  skills: "Cloud Skills",
  environments: "Environments",
  "claude-code-harness": "The Claude Code host runtime",
  "codex-harness": "The Codex host runtime",
  "cursor-harness": "The Cursor CLI host runtime",
  "org-registry": "The registry directory",
  "shared-slack-channel": "Shared Slack channels",
  "trace-destinations": "Trace destinations",
  "grading-engine-mode": "The grading engine",
  "description-experiments": "Description experiments",
  conformance: "Conformance",
  "unified-sessions": "The unified sessions feed",
  "unified-share-evals": "Eval run sharing",
  "unified-share-conformance": "Conformance run sharing",
  "github-checks": "GitHub checks",
  plugins: "Agent Plugins",
  "scheduled-evals": "Scheduled evals",
};

/**
 * The feature an operation belongs to:
 *
 * - `null`: released, available to everyone the operation's own permissions
 *   admit.
 * - a key: available when that feature is.
 * - a list: available when ANY of them is. Only for an operation that serves
 *   several resource types each behind its own feature; the backend still
 *   checks the resource type on each call.
 */
export type OperationFeature =
  PlatformFeatureKey | readonly PlatformFeatureKey[] | null;

const SHARE_FAMILY: readonly PlatformFeatureKey[] = [
  "unified-share-evals",
  "unified-share-conformance",
  "sandboxes",
];

/** Every operation name, deprecated aliases included, to its feature. */
export const OPERATION_FEATURES: Readonly<Record<string, OperationFeature>> = {
  // Conformance and directory readiness.
  start_claude_readiness_run: "conformance",
  start_openai_readiness_run: "conformance",
  get_readiness_report: "conformance",
  start_conformance_run: "conformance",
  get_conformance_run: "conformance",
  list_conformance_runs: "conformance",
  get_conformance_report: "conformance",
  // The unified sessions feed. `list_chat_sessions` reads chat sessions,
  // which are released.
  search_sessions: "unified-sessions",
  // The registry directory. The organization's own registry
  // (`*_registry_server*`, `list_registry_connections`) is released.
  search_registry_directory: "org-registry",
  get_registry_directory_server: "org-registry",
  list_registry_directory_sources: "org-registry",
  install_registry_directory_server: "org-registry",
  // The hosted browser.
  drive_chat_session_browser: "hosted-browser",
  observe_chat_session_browser: "hosted-browser",
  // Cloud Skills. A server's own skills (`*_server_skill*`) are released.
  list_project_skills: "skills",
  get_project_skill: "skills",
  // Custom sandbox images: authoring, building, promoting and pinning one.
  // Pinning also needs `computers` when the caller has no computer yet.
  create_sandbox_image: "sandbox-images",
  update_sandbox_image: "sandbox-images",
  validate_sandbox_image_blueprint: "sandbox-images",
  build_sandbox_image: "sandbox-images",
  list_sandbox_image_builds: "sandbox-images",
  promote_sandbox_image: "sandbox-images",
  use_sandbox_image: "sandbox-images",
  // The personal computer itself.
  reset_computer: "computers",
  // Named environments. Reading one, and the ad-hoc compose path
  // (`ensure_adhoc_environment`), are released.
  create_project_environment: "environments",
  name_environment: "environments",
  update_project_environment: "environments",
  restore_project_environment: "environments",
  // Trace destinations.
  create_trace_destination: "trace-destinations",
  update_trace_destination: "trace-destinations",
  test_trace_destination: "trace-destinations",
  resume_trace_destination: "trace-destinations",
  backfill_trace_destination: "trace-destinations",
  list_trace_destination_backfills: "trace-destinations",
  // Agent Plugins. Running a plugin's extensions (`plugin-extensions`)
  // happens in chat, not through an operation.
  list_project_plugins: "plugins",
  get_plugin_version: "plugins",
  // GitHub checks for eval suites.
  list_eval_github_repos: "github-checks",
  connect_eval_github_repo: "github-checks",
  list_eval_check_repos: "github-checks",
  connect_eval_check_repo: "github-checks",
  // Description experiments.
  propose_eval_description_rewrite: "description-experiments",
  start_eval_description_experiment: "description-experiments",
  get_eval_description_experiment: "description-experiments",
  // Swarms, goals, personas and studies.
  create_persona: "sandboxes",
  update_persona: "sandboxes",
  generate_personas: "sandboxes",
  create_goal: "sandboxes",
  update_goal: "sandboxes",
  generate_goals: "sandboxes",
  list_goal_run_sessions: "sandboxes",
  launch_goal_run: "sandboxes",
  get_goal_run_scorecard: "sandboxes",
  create_swarm: "sandboxes",
  update_swarm: "sandboxes",
  get_swarms_overview: "sandboxes",
  list_swarm_findings: "sandboxes",
  dismiss_swarm_finding: "sandboxes",
  undismiss_swarm_finding: "sandboxes",
  get_swarm_run_insights: "sandboxes",
  request_swarm_run_insights: "sandboxes",
  publish_study: "sandboxes",
  list_study_sessions: "sandboxes",
  get_study_session: "sandboxes",
  get_study_metrics: "sandboxes",
  get_study_usage: "sandboxes",
  list_study_findings: "sandboxes",
  get_study_signals: "sandboxes",
  get_study_insights: "sandboxes",
  request_study_insights: "sandboxes",
  dismiss_study_finding: "sandboxes",
  undismiss_study_finding: "sandboxes",
  upsert_study_member: "sandboxes",
  rebind_study: "sandboxes",
  // Minting a new share link, for several resource types: available when any
  // of them is. The backend checks the resource type (study shares follow
  // `sandboxes`, eval and conformance runs their own share beta).
  rotate_share_link: SHARE_FAMILY,
  // Kept available whatever the feature reports: what the backend leaves
  // open on purpose so an organization that lost a feature can still stop,
  // take down or clean up what it started or authored (a schedule, trace
  // egress, a running readiness or goal run or insights job, a public study
  // or share, an authored persona, goal, swarm, image or environment). Hiding
  // it would strand that organization with no advertised way to do so. The
  // reads needed to find what to stop stay with it. Starting, widening and
  // resuming are still refused server-side.
  set_eval_suite_schedule: null,
  list_trace_destinations: null,
  get_trace_destination: null,
  pause_trace_destination: null,
  delete_trace_destination: null,
  list_goal_runs: null,
  get_goal_run: null,
  cancel_goal_run: null,
  list_studies: null,
  get_study: null,
  // Renames a study or sets who may open its link. The backend does not gate
  // it at all, so it narrows access after the feature is gone.
  update_study: null,
  unpublish_study: null,
  remove_study_member: null,
  rotate_study_link: null,
  set_study_guest_execution: null,
  get_share_settings: null,
  set_share_mode: null,
  list_readiness_runs: null,
  get_readiness_run: null,
  cancel_readiness_run: null,
  list_personas: null,
  get_persona: null,
  delete_persona: null,
  list_goals: null,
  get_goal: null,
  archive_goal: null,
  list_swarms: null,
  get_swarm: null,
  archive_swarm: null,
  cancel_swarm_run_insights: null,
  cancel_study_insights: null,
  list_sandbox_images: null,
  get_sandbox_image: null,
  delete_sandbox_image: null,
  archive_project_environment: null,
  // Released: no feature.
  get_me: null,
  list_models: null,
  list_organizations: null,
  list_projects: null,
  create_project: null,
  update_project: null,
  delete_project: null,
  list_project_servers: null,
  show_servers: null,
  connect_project_server: null,
  get_project_server_connection_status: null,
  cancel_project_server_connection: null,
  diagnose_server: null,
  validate_server: null,
  export_server: null,
  list_server_tools: null,
  list_server_prompts: null,
  list_server_resources: null,
  call_server_tool: null,
  render_server_widget: null,
  get_server_prompt: null,
  read_server_resource: null,
  list_server_skills: null,
  get_server_skill: null,
  read_server_skill_file: null,
  check_host_compatibility: null,
  list_eval_suites: null,
  list_eval_suite_runs: null,
  run_eval_suite: null,
  run_eval_case: null,
  create_eval_suite: null,
  get_eval_suite: null,
  get_eval_run_disclosure: null,
  update_eval_suite: null,
  list_eval_suite_revisions: null,
  delete_eval_suite: null,
  set_eval_suite_environments: null,
  list_eval_cases: null,
  get_eval_case: null,
  create_eval_case: null,
  create_eval_cases: null,
  update_eval_case: null,
  delete_eval_case: null,
  generate_eval_cases: null,
  import_eval_cases: null,
  get_eval_run: null,
  get_eval_run_stage_analytics: null,
  get_eval_run_gate: null,
  get_eval_run_route_facts: null,
  get_eval_run_server_facts: null,
  list_eval_suite_stage_analytics: null,
  compare_eval_run: null,
  list_eval_run_iterations: null,
  get_eval_iteration_trace: null,
  cancel_eval_run: null,
  waive_eval_gate: null,
  get_eval_gate_waiver: null,
  revoke_eval_gate_waiver: null,
  backtest_eval_run: null,
  backtest_eval_run_judge: null,
  request_eval_run_judge: null,
  get_eval_run_steps: null,
  create_tunnel: null,
  close_tunnel: null,
  list_chat_sessions: null,
  send_chat_message: null,
  get_chat_session: null,
  get_chat_session_trace: null,
  list_clients: null,
  get_client: null,
  create_client: null,
  update_client: null,
  delete_client: null,
  set_client_servers: null,
  duplicate_client: null,
  list_project_environments: null,
  get_project_environment_capabilities: null,
  get_project_environment: null,
  resolve_project_environment: null,
  ensure_adhoc_environment: null,
  create_project_server: null,
  get_project_server: null,
  update_project_server: null,
  delete_project_server: null,
  get_capabilities: null,
  list_secrets: null,
  get_secret: null,
  create_secret: null,
  update_secret: null,
  delete_secret: null,
  list_registry_servers: null,
  list_registry_connections: null,
  install_registry_server: null,
  uninstall_registry_server: null,
  send_feedback: null,
  // Deprecated aliases, absent from `ALL_OPERATIONS`: the same feature as
  // the operation that replaced them.
  create_journey: "sandboxes",
  dismiss_user_testing_finding: "sandboxes",
  generate_journeys: "sandboxes",
  get_journey_run_scorecard: "sandboxes",
  get_user_testing_insights: "sandboxes",
  get_user_testing_metrics: "sandboxes",
  get_user_testing_session: "sandboxes",
  get_user_testing_signals: "sandboxes",
  get_user_testing_usage: "sandboxes",
  get_wave_insights: "sandboxes",
  launch_journey_run: "sandboxes",
  list_journey_run_sessions: "sandboxes",
  list_user_testing_findings: "sandboxes",
  list_user_testing_sessions: "sandboxes",
  publish_scenario: "sandboxes",
  rebind_user_testing_scenario: "sandboxes",
  request_user_testing_insights: "sandboxes",
  request_wave_insights: "sandboxes",
  undismiss_user_testing_finding: "sandboxes",
  update_journey: "sandboxes",
  upsert_user_testing_member: "sandboxes",
  // The deprecated aliases of the operations kept available above.
  archive_journey: null,
  get_journey: null,
  list_journeys: null,
  cancel_user_testing_insights: null,
  cancel_wave_insights: null,
  cancel_journey_run: null,
  get_journey_run: null,
  list_journey_runs: null,
  get_scenario: null,
  get_user_testing_scenario: null,
  list_scenarios: null,
  remove_user_testing_member: null,
  rotate_user_testing_link: null,
  set_user_testing_guest_execution: null,
  update_user_testing_scenario: null,
  unpublish_scenario: null,
  create_host: null,
  delete_host: null,
  duplicate_host: null,
  get_host: null,
  list_hosts: null,
  set_host_servers: null,
  update_host: null,
};

/**
 * The feature `name` belongs to, or `undefined` for a name this SDK does not
 * know. Own properties only, so `"__proto__"` and friends are unknown too.
 */
export function operationFeature(name: string): OperationFeature | undefined {
  return Object.prototype.hasOwnProperty.call(OPERATION_FEATURES, name)
    ? OPERATION_FEATURES[name]
    : undefined;
}

/**
 * Feature availability as the platform reports it: `true` means on. Fails
 * closed: a feature that is missing, or anything other than `true`, is off.
 */
export type FeatureAvailability = Readonly<Record<string, boolean | undefined>>;

function featureOn(features: FeatureAvailability, key: PlatformFeatureKey) {
  return (
    Object.prototype.hasOwnProperty.call(features, key) &&
    features[key] === true
  );
}

/**
 * Whether the caller can use operation `name`, given `features`. An operation
 * this SDK does not know is not available.
 */
export function isOperationAvailable(
  name: string,
  features: FeatureAvailability
): boolean {
  const feature = operationFeature(name);
  if (feature === undefined) return false;
  if (feature === null) return true;
  return typeof feature === "string"
    ? featureOn(features, feature)
    : feature.some((key) => featureOn(features, key));
}

/** The operations `features` leaves unavailable, in table order. */
export function disabledOperations(features: FeatureAvailability): string[] {
  return Object.keys(OPERATION_FEATURES).filter(
    (name) => !isOperationAvailable(name, features)
  );
}
