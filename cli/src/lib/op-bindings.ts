/**
 * Which platform operation each CLI command exposes — and, for the ones the CLI
 * deliberately does not expose, why.
 *
 * The CLI was the last of the five operation surfaces with no drift check. The
 * MCP catalog, the agent registry and the in-app chat toolset each partition
 * `ALL_OPERATIONS` into "advertised" and "excluded, with a reason", enforced by
 * a test that fails both when an operation is missed and when an exclusion goes
 * stale. This is that partition for the CLI.
 *
 * The reason it matters here specifically: an operation with no CLI binding is
 * invisible from a shell script, and nothing about adding an SDK operation
 * prompts anyone to notice. `list_eval_suite_runs` sat unreachable for exactly
 * that reason — the operation, the route and the MCP tool all existed.
 *
 * A binding names the command path a user would type. The test resolves each
 * one against the real Commander tree, so an entry claiming a command that was
 * never registered (or was later renamed) fails rather than quietly asserting
 * coverage that does not exist.
 */

/** A command path (`"eval runs"`), or a documented reason for having none. */
export type CliBinding = { command: string } | { excluded: string };

export const CLI_BINDINGS: Readonly<Record<string, CliBinding>> = {
  // ── Organizations ───────────────────────────────────────────────────────
  // Read-only, and the only organization command there is. Member, role,
  // invite and billing writes are account administration and stay in the app.
  list_organizations: { command: "cloud organizations list" },

  // ── Projects and servers ────────────────────────────────────────────────
  list_projects: { command: "cloud projects list" },
  create_project: { command: "cloud projects create" },
  update_project: { command: "cloud projects update" },
  delete_project: { command: "cloud projects delete" },
  list_project_servers: { command: "cloud projects servers" },
  create_project_server: { command: "cloud projects servers add" },
  connect_project_server: { command: "cloud projects servers connect" },
  // Its OWN command, not `servers connect`. `connect` does poll this operation
  // while it waits, but `--no-wait` and Ctrl-C both hand back a request id, and
  // pointing the binding at `connect` claimed a command that could not follow
  // one — re-running `connect` starts a second request rather than reading the
  // first.
  get_project_server_connection_status: {
    command: "cloud projects servers connect-status",
  },
  get_project_server: { command: "cloud projects servers get" },
  update_project_server: { command: "cloud projects servers update" },
  delete_project_server: { command: "cloud projects servers remove" },
  show_servers: { command: "cloud projects status" },

  // ── Journeys (the Swarms product) ───────────────────────────────────────
  // Flag-gated beta. Bound normally rather than excluded: the server returns a
  // clean "not currently available for your organization" when the flag is off,
  // which is a better answer than a command that does not exist. Same shape as
  // `environments` and `images` for an org that lacks those.
  list_journeys: { command: "cloud journeys list" },
  list_journey_runs: { command: "cloud journeys runs" },
  get_journey_run: { command: "cloud journeys status" },
  list_journey_run_sessions: { command: "cloud journeys sessions" },
  launch_journey_run: { command: "cloud journeys run" },
  cancel_journey_run: { command: "cloud journeys cancel" },
  // Authoring + insights, in `commands/swarms.ts` but hung off the same
  // `journeys` group so `journeys run` and `journeys create` are one surface
  // to the person typing them.
  get_journey: { command: "cloud journeys get" },
  create_journey: { command: "cloud journeys create" },
  update_journey: { command: "cloud journeys update" },
  archive_journey: { command: "cloud journeys archive" },
  generate_journeys: { command: "cloud journeys generate" },
  get_swarms_overview: { command: "cloud journeys overview" },
  get_journey_run_scorecard: { command: "cloud journeys scorecard" },
  list_swarm_findings: { command: "cloud journeys findings" },
  dismiss_swarm_finding: { command: "cloud journeys dismiss-finding" },
  undismiss_swarm_finding: { command: "cloud journeys undismiss-finding" },
  get_wave_insights: { command: "cloud journeys insights" },
  request_wave_insights: { command: "cloud journeys request-insights" },
  cancel_wave_insights: { command: "cloud journeys cancel-insights" },

  // ── Personas and swarm containers (Swarms authoring) ────────────────────
  list_personas: { command: "cloud personas list" },
  get_persona: { command: "cloud personas get" },
  create_persona: { command: "cloud personas create" },
  update_persona: { command: "cloud personas update" },
  delete_persona: { command: "cloud personas delete" },
  generate_personas: { command: "cloud personas generate" },
  list_swarms: { command: "cloud swarms list" },
  get_swarm: { command: "cloud swarms get" },
  create_swarm: { command: "cloud swarms create" },
  update_swarm: { command: "cloud swarms update" },
  archive_swarm: { command: "cloud swarms archive" },

  // ── Capabilities ────────────────────────────────────────────────────────
  // Nested under projects: the answer is project-scoped (role, org betas,
  // plan limits) even though it spans Swarms, user testing, and the plan.
  get_capabilities: { command: "cloud projects capabilities" },

  // ── Scenarios (user testing) ────────────────────────────────────────────
  // Publishing and taking down. The reads (`scenarios list` / `scenarios get`)
  // are bound under "Chat surfaces" below — they used to be a separate group
  // under the product's older name, and now share this one command.
  publish_scenario: { command: "cloud scenarios publish" },
  unpublish_scenario: { command: "cloud scenarios unpublish" },
  // ── User testing: everything you do with a scenario once it exists ──────
  get_user_testing_scenario: { command: "cloud user-testing get" },
  update_user_testing_scenario: { command: "cloud user-testing update" },
  list_user_testing_sessions: { command: "cloud user-testing sessions" },
  get_user_testing_session: { command: "cloud user-testing session" },
  get_user_testing_metrics: { command: "cloud user-testing metrics" },
  get_user_testing_usage: { command: "cloud user-testing usage" },
  list_user_testing_findings: { command: "cloud user-testing findings" },
  get_user_testing_signals: { command: "cloud user-testing signals" },
  get_user_testing_insights: { command: "cloud user-testing insights" },
  request_user_testing_insights: {
    command: "cloud user-testing request-insights",
  },
  cancel_user_testing_insights: {
    command: "cloud user-testing cancel-insights",
  },
  dismiss_user_testing_finding: {
    command: "cloud user-testing dismiss-finding",
  },
  undismiss_user_testing_finding: {
    command: "cloud user-testing undismiss-finding",
  },
  set_user_testing_guest_execution: {
    command: "cloud user-testing guest-execution",
  },
  rotate_user_testing_link: { command: "cloud user-testing rotate-link" },
  upsert_user_testing_member: { command: "cloud user-testing invite" },
  remove_user_testing_member: { command: "cloud user-testing remove-member" },
  rebind_user_testing_scenario: { command: "cloud user-testing rebind" },

  // ── Evals ───────────────────────────────────────────────────────────────
  list_eval_suites: { command: "cloud eval list" },
  create_eval_suite: { command: "cloud eval create" },
  get_eval_suite: { command: "cloud eval get" },
  update_eval_suite: { command: "cloud eval update" },
  delete_eval_suite: { command: "cloud eval delete" },
  set_eval_suite_schedule: { command: "cloud eval schedule" },
  set_eval_suite_environments: { command: "cloud eval environments set" },
  list_eval_suite_runs: { command: "cloud eval runs" },
  run_eval_suite: { command: "cloud eval run" },
  cancel_eval_run: { command: "cloud eval cancel" },
  request_eval_run_judge: { command: "cloud eval judge" },
  list_eval_check_repos: { command: "cloud eval checks list" },
  connect_eval_check_repo: { command: "cloud eval checks connect" },
  get_eval_run: { command: "cloud eval status" },
  compare_eval_run: { command: "cloud eval compare" },
  list_eval_run_iterations: { command: "cloud eval iterations" },
  get_eval_iteration_trace: { command: "cloud eval trace" },
  get_eval_run_steps: { command: "cloud eval steps" },
  list_eval_cases: { command: "cloud eval cases list" },
  get_eval_case: { command: "cloud eval cases get" },
  create_eval_case: { command: "cloud eval cases create" },
  create_eval_cases: {
    excluded:
      'Authoring several cases from a shell means passing a FILE, and that file\'s format is now settled: the versioned eval suite file (`schemaVersion: "1"`, YAML canonical, JSON accepted, conventionally `.mcpjam/evals/*.yaml`), which `eval validate` reads offline and `eval export` writes. What is still missing is the UPLOAD half — a suite file has cases with declared ids and the batch surface takes cases inline, and deciding which of the two owns identity on the way up is the same decision as `eval run --file`\'s ownership rules. So this binds when that command lands, not before; a batch command today would ship a second spelling of "send these cases" ahead of it. The bulk writers meanwhile are the agent surfaces (MCP `create_eval_cases`, `POST …/cases/batch`), which take the cases inline.',
  },
  update_eval_case: { command: "cloud eval cases update" },
  delete_eval_case: { command: "cloud eval cases delete" },
  generate_eval_cases: { command: "cloud eval cases generate" },
  run_eval_case: { command: "cloud eval cases run" },

  // ── Hosts, environments, images ─────────────────────────────────────────
  list_hosts: { command: "cloud hosts list" },
  get_host: { command: "cloud hosts get" },
  create_host: { command: "cloud hosts create" },
  update_host: { command: "cloud hosts update" },
  delete_host: { command: "cloud hosts delete" },
  set_host_servers: { command: "cloud hosts servers" },
  duplicate_host: { command: "cloud hosts duplicate" },
  list_project_environments: { command: "cloud environments list" },
  get_project_environment_capabilities: {
    excluded:
      "Not a user-facing command: it answers 'does this deployment accept a model override?', which `environments create --model` / `environments update --model|--clear-model` already ask on the caller's behalf before writing. A standalone command would only invite people to check by hand what the write already checks.",
  },
  get_project_environment: { command: "cloud environments get" },
  resolve_project_environment: { command: "cloud environments resolve" },
  create_project_environment: { command: "cloud environments create" },
  ensure_adhoc_environment: { command: "cloud environments ensure-adhoc" },
  name_environment: { command: "cloud environments name" },
  update_project_environment: { command: "cloud environments update" },
  archive_project_environment: { command: "cloud environments archive" },
  restore_project_environment: { command: "cloud environments restore" },
  list_project_plugins: {
    excluded:
      "No `plugins` command group yet — the read surface shipped for the MCP catalog and API first. Bind both plugin reads together when the CLI grows one.",
  },
  get_plugin_version: {
    excluded:
      "No `plugins` command group yet — the read surface shipped for the MCP catalog and API first. Bind both plugin reads together when the CLI grows one.",
  },
  list_sandbox_images: { command: "cloud images list" },
  get_sandbox_image: { command: "cloud images get" },
  create_sandbox_image: { command: "cloud images create" },
  update_sandbox_image: { command: "cloud images edit" },
  validate_sandbox_image_blueprint: { command: "cloud images validate" },
  build_sandbox_image: { command: "cloud images build" },
  list_sandbox_image_builds: { command: "cloud images logs" },
  promote_sandbox_image: { command: "cloud images promote" },
  use_sandbox_image: { command: "cloud images use" },
  delete_sandbox_image: { command: "cloud images delete" },
  reset_computer: { command: "cloud images reset" },

  // ── Chat surfaces ───────────────────────────────────────────────────────
  list_scenarios: { command: "cloud scenarios list" },
  get_scenario: { command: "cloud scenarios get" },
  list_chat_sessions: { command: "cloud sessions list" },
  search_sessions: { command: "cloud sessions search" },

  // ── Tunnels ─────────────────────────────────────────────────────────────
  create_tunnel: { command: "cloud tunnel" },
  close_tunnel: {
    excluded:
      "The tunnel closes when `mcpjam cloud tunnel` exits; a separate close command would only strand a session nobody is holding.",
  },

  // ── Deliberately local-first ────────────────────────────────────────────
  // The CLI talks to MCP servers DIRECTLY (--url / config file) rather than
  // through the platform, so a developer can inspect a server that is not
  // saved in any project and without an API key. Routing these through the
  // hosted operations would make the platform a prerequisite for the CLI's
  // most common use. A hosted variant is a real feature request, not an
  // oversight — it would need its own `--project` mode.
  list_server_tools: {
    excluded:
      "`tools list` connects to the server directly, so it works without a project or an API key.",
  },
  call_server_tool: {
    excluded:
      "`tools call` connects to the server directly, so it works without a project or an API key.",
  },
  list_server_prompts: {
    excluded:
      "`prompts list` connects to the server directly, so it works without a project or an API key.",
  },
  get_server_prompt: {
    excluded:
      "`prompts get` connects to the server directly, so it works without a project or an API key.",
  },
  list_server_resources: {
    excluded:
      "`resources list` connects to the server directly, so it works without a project or an API key.",
  },
  read_server_resource: {
    excluded:
      "`resources read` connects to the server directly, so it works without a project or an API key.",
  },
  diagnose_server: {
    excluded:
      "`server doctor` runs the same sweep locally; the hosted variant is reachable through `projects status`.",
  },
  validate_server: {
    excluded:
      "`server validate` runs locally against any reachable server, saved or not.",
  },
  export_server: {
    excluded:
      "`server export` writes a snapshot of any reachable server without needing it saved first.",
  },
  check_host_compatibility: {
    excluded:
      "`compat` evaluates the bundled catalog locally, so it stays fast and works offline.",
  },
  // Directory readiness, hosted half. NOT excluded-citing-local like its
  // neighbours above: `readiness check` grades what THIS machine can reach,
  // and a hosted run grades the server as the platform reaches it, through the
  // saved row and the authorize exchange. Different questions, and only the
  // hosted one can spend for model observations or leave a record.
  start_claude_readiness_run: { command: "readiness start claude" },
  start_openai_readiness_run: { command: "readiness start openai" },
  get_readiness_run: { command: "readiness status" },
  list_readiness_runs: { command: "readiness list" },
  cancel_readiness_run: { command: "readiness cancel" },
  get_readiness_report: { command: "readiness report" },

  // ── Covered by the surrounding session, not a command ────────────────────
  get_me: {
    excluded:
      "`cloud whoami` already reports the signed-in identity for the stored credentials.",
  },
  list_models: {
    excluded:
      "Model choice belongs to whatever runs an eval; the CLI never picks one on the user's behalf.",
  },
};
