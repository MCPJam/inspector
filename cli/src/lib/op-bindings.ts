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
  // ── Projects and servers ────────────────────────────────────────────────
  list_projects: { command: "projects list" },
  create_project: { command: "projects create" },
  update_project: { command: "projects update" },
  delete_project: { command: "projects delete" },
  list_project_servers: { command: "projects servers" },
  create_project_server: { command: "projects server add" },
  connect_project_server: { command: "projects server connect" },
  // Its OWN command, not `server connect`. `connect` does poll this operation
  // while it waits, but `--no-wait` and Ctrl-C both hand back a request id, and
  // pointing the binding at `connect` claimed a command that could not follow
  // one — re-running `connect` starts a second request rather than reading the
  // first.
  get_project_server_connection_status: {
    command: "projects server connect-status",
  },
  get_project_server: { command: "projects server get" },
  update_project_server: { command: "projects server update" },
  delete_project_server: { command: "projects server remove" },
  show_servers: { command: "projects status" },

  // ── Journeys (the Swarms product) ───────────────────────────────────────
  // Flag-gated beta. Bound normally rather than excluded: the server returns a
  // clean "not currently available for your organization" when the flag is off,
  // which is a better answer than a command that does not exist. Same shape as
  // `environments` and `images` for an org that lacks those.
  list_journeys: { command: "journeys list" },
  list_journey_runs: { command: "journeys runs" },
  get_journey_run: { command: "journeys status" },
  list_journey_run_sessions: { command: "journeys sessions" },
  launch_journey_run: { command: "journeys run" },
  cancel_journey_run: { command: "journeys cancel" },

  // ── Scenarios (user testing) ────────────────────────────────────────────
  // Supersedes the `chatboxes` group below, which is the same product under
  // its older name.
  publish_scenario: { command: "scenarios publish" },
  unpublish_scenario: { command: "scenarios unpublish" },

  // ── Evals ───────────────────────────────────────────────────────────────
  list_eval_suites: { command: "eval list" },
  create_eval_suite: { command: "eval create" },
  get_eval_suite: { command: "eval get" },
  update_eval_suite: { command: "eval update" },
  delete_eval_suite: { command: "eval delete" },
  set_eval_suite_schedule: { command: "eval schedule" },
  set_eval_suite_environments: { command: "eval environments set" },
  list_eval_suite_runs: { command: "eval runs" },
  run_eval_suite: { command: "eval run" },
  cancel_eval_run: { command: "eval cancel" },
  get_eval_run: { command: "eval status" },
  list_eval_run_iterations: { command: "eval iterations" },
  get_eval_iteration_trace: { command: "eval trace" },
  get_eval_run_steps: { command: "eval steps" },
  list_eval_cases: { command: "eval cases list" },
  get_eval_case: { command: "eval cases get" },
  create_eval_case: { command: "eval cases create" },
  update_eval_case: { command: "eval cases update" },
  delete_eval_case: { command: "eval cases delete" },
  generate_eval_cases: { command: "eval cases generate" },
  run_eval_case: { command: "eval cases run" },

  // ── Hosts, environments, images ─────────────────────────────────────────
  list_hosts: { command: "hosts list" },
  get_host: { command: "hosts get" },
  create_host: { command: "hosts create" },
  update_host: { command: "hosts update" },
  delete_host: { command: "hosts delete" },
  set_host_servers: { command: "hosts servers" },
  duplicate_host: { command: "hosts duplicate" },
  list_project_environments: { command: "environments list" },
  get_project_environment_capabilities: {
    excluded:
      "Not a user-facing command: it answers 'does this deployment accept a model override?', which `environments create --model` / `environments update --model|--clear-model` already ask on the caller's behalf before writing. A standalone command would only invite people to check by hand what the write already checks.",
  },
  get_project_environment: { command: "environments get" },
  resolve_project_environment: { command: "environments resolve" },
  create_project_environment: { command: "environments create" },
  update_project_environment: { command: "environments update" },
  archive_project_environment: { command: "environments archive" },
  restore_project_environment: { command: "environments restore" },
  list_project_plugins: {
    excluded:
      "No `plugins` command group yet — the read surface shipped for the MCP catalog and API first. Bind both plugin reads together when the CLI grows one.",
  },
  get_plugin_version: {
    excluded:
      "No `plugins` command group yet — the read surface shipped for the MCP catalog and API first. Bind both plugin reads together when the CLI grows one.",
  },
  list_sandbox_images: { command: "images list" },
  get_sandbox_image: { command: "images get" },
  create_sandbox_image: { command: "images create" },
  update_sandbox_image: { command: "images edit" },
  validate_sandbox_image_blueprint: { command: "images validate" },
  build_sandbox_image: { command: "images build" },
  list_sandbox_image_builds: { command: "images logs" },
  promote_sandbox_image: { command: "images promote" },
  use_sandbox_image: { command: "images use" },
  delete_sandbox_image: { command: "images delete" },
  reset_computer: { command: "images reset" },

  // ── Chat surfaces ───────────────────────────────────────────────────────
  list_chatboxes: { command: "chatboxes list" },
  get_chatbox: { command: "chatboxes get" },
  list_chat_sessions: { command: "chat-sessions list" },

  // ── Tunnels ─────────────────────────────────────────────────────────────
  create_tunnel: { command: "tunnel" },
  close_tunnel: {
    excluded:
      "The tunnel closes when `mcpjam tunnel` exits; a separate close command would only strand a session nobody is holding.",
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

  // ── Covered by the surrounding session, not a command ────────────────────
  get_me: {
    excluded:
      "`auth whoami` already reports the signed-in identity for the stored credentials.",
  },
  list_models: {
    excluded:
      "Model choice belongs to whatever runs an eval; the CLI never picks one on the user's behalf.",
  },
};
