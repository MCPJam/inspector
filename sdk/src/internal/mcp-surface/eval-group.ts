import { HELD_OPERATION_NAMES } from "./hold.js";

/**
 * The tools `mcpjam mcp --evals` serves: every eval tool the hosted MCP server
 * lists, plus the read tools an agent needs to fill one in. Named rather than
 * matched by pattern, because operations carry no domain; a hosted test fails
 * when a new tool with "eval" in its name is in neither this list nor
 * `NOT_EVAL_TOOL_NAMES`.
 *
 * Held betas are listed too, so they reach local MCP the day the hosted
 * server releases them.
 */
export const EVAL_TOOL_NAMES = [
  // Suites and cases.
  "list_eval_suites",
  "get_eval_suite",
  "create_eval_suite",
  "update_eval_suite",
  "delete_eval_suite",
  "list_eval_suite_revisions",
  "set_eval_suite_environments",
  "list_eval_suite_runs",
  "list_eval_suite_stage_analytics",
  "list_eval_cases",
  "get_eval_case",
  "create_eval_case",
  "create_eval_cases",
  "update_eval_case",
  "delete_eval_case",
  "generate_eval_cases",
  "import_eval_cases",
  // Runs and their results.
  "run_eval_suite",
  "run_eval_case",
  "get_eval_run",
  "get_eval_run_disclosure",
  "get_eval_run_stage_analytics",
  "get_eval_run_gate",
  "get_eval_run_route_facts",
  "get_eval_run_server_facts",
  "compare_eval_run",
  "get_eval_gate_waiver",
  "list_eval_run_iterations",
  "get_eval_iteration_trace",
  "get_eval_run_steps",
  "cancel_eval_run",
  "backtest_eval_run",
  "backtest_eval_run_judge",
  "request_eval_run_judge",
  "build_eval_run_findings",
  "request_eval_run_insights",
  "cancel_eval_run_insights",
  // Held on the hosted server while in beta.
  "list_eval_github_repos",
  "connect_eval_github_repo",
  "list_eval_check_repos",
  "connect_eval_check_repo",
  "propose_eval_description_rewrite",
  "start_eval_description_experiment",
  "get_eval_description_experiment",
  "set_eval_suite_schedule",
  // The names a suite or a run needs: a project, a server, a model, a client
  // and an environment.
  "list_projects",
  "list_project_servers",
  "list_models",
  "list_clients",
  "list_project_environments",
] as const;

export type EvalToolName = (typeof EVAL_TOOL_NAMES)[number];

/** Tools with "eval" in their name that belong to another flow. */
export const NOT_EVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // A directory submission's evals, part of the directory review flow.
  "get_directory_submission_evals",
  "set_directory_submission_evals",
]);

/** The eval tools local MCP lists: the group, with held betas still held. */
export function localEvalToolNames(): EvalToolName[] {
  return EVAL_TOOL_NAMES.filter((name) => !HELD_OPERATION_NAMES.has(name));
}
