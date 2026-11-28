import type { ToolAnnotations } from "@modelcontextprotocol/client";
import {
  ALL_OPERATIONS,
  cancelEvalRunOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  deleteProjectOperation,
  deleteProjectServerOperation,
  type PlatformOperation,
} from "../../platform/index.js";
import { isClosedWorldOperation } from "./closed-world.js";

/**
 * Operations that REMOVE OR INVALIDATE something that already existed, DERIVED
 * from the catalog's own `risk` metadata rather than listed here.
 *
 * Not only permanent deletion: `update_client` and `set_client_servers` carry
 * `risk: "destructive"` because replacing a live setting invalidates the one
 * that was in force, and a replacement server list detaches every server it
 * omits. They remain in the catalog behind compare-and-set; what stays OUT is
 * resource removal, which no precondition makes recoverable.
 *
 * Deriving is the whole point of that field: it exists so five surfaces make
 * one decision from one place instead of each re-deriving it. This set can
 * only ADD to what `ADDITIVE_WRITE_NAMES` below already leaves destructive; a
 * `risk: "destructive"` operation is never advertised as additive, even if
 * someone lists it there.
 *
 * `LEGACY_DESTRUCTIVE_NAMES` covers the operations that predate `risk`. It
 * shrinks to nothing as those are backfilled; it does not grow.
 */
const LEGACY_DESTRUCTIVE_NAMES: ReadonlySet<string> = new Set([
  deleteEvalSuiteOperation.name,
  deleteEvalCaseOperation.name,
  deleteProjectServerOperation.name,
  deleteProjectOperation.name,
  // Cancelling a run terminates in-flight work.
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
 * Writes that are PURELY ADDITIVE — they create new rows or start new work and
 * never change, replace, cancel, revoke or delete anything that already
 * exists. Only these advertise `destructiveHint: false`; every other write
 * advertises `true`.
 *
 * Claude's directory review asks for `destructiveHint: true` on every tool
 * that "modifies or deletes data", which is wider than `risk: "destructive"`:
 * an update overwrites what was there, a forced insight regeneration replaces
 * the previous analysis, a cancel ends work in flight, and making a project
 * private revokes members' access. The MCP spec reads the same way — `false`
 * promises "only additive updates". So the hint is not derived from `risk`.
 *
 * OPT-IN, one name at a time, and that direction is the point: a write nobody
 * reviewed advertises the conservative `true`. A forgotten entry here costs a
 * confirmation prompt; a forgotten entry in a deny-list would tell clients a
 * destructive tool is safe. Audited against the handlers on 2026-10-06.
 *
 * Deliberately NOT here, though they look additive:
 * - `connect_project_server` and `install_registry_server`: a new connection
 *   request can evict the caller's oldest unopened one at the concurrency cap,
 *   and `reauthorize` cancels the requests in flight for that URL.
 * - `request_eval_run_judge`, `request_swarm_run_insights`,
 *   `request_study_insights`: a forced or failed-only regrade overwrites the
 *   stored verdicts or analysis.
 * - `upsert_study_member`: re-inviting clears `revokedAt`, so it can restore
 *   access someone revoked.
 * - `run_eval_suite`: `refreshSnapshot` replaces the suite's saved snapshot,
 *   and the run can invoke third-party tools with destructive effects.
 * - `run_eval_case` and `launch_goal_run`: their agents can invoke the same
 *   third-party write tools, even though the run records themselves are new.
 */
const ADDITIVE_WRITE_NAMES: ReadonlySet<string> = new Set([
  "create_project",
  "create_project_server",
  "create_eval_suite",
  "create_eval_case",
  "create_eval_cases",
  "generate_eval_cases",
  "import_eval_cases",
  "backtest_eval_run",
  "backtest_eval_run_judge",
  // A fresh box per test, released after; the suite and run are untouched.
  "test_eval_code_evaluator",
  "ensure_adhoc_environment",
  "create_persona",
  "generate_personas",
  "create_goal",
  "generate_goals",
  "create_swarm",
  // Each call mints a new study with its own share link; a taken name is
  // refused rather than overwritten.
  "publish_study",
  "create_client",
  "duplicate_client",
  // A new rehearsal; a replayed key returns the one it made.
  "create_directory_submission",
  // Append-only events about a submission: a newer record supersedes an
  // older one in the summary, and the older one stays as it was.
  "record_directory_submission_status",
  "record_directory_submission_snapshot",
  "import_directory_finding",
  // New eval cases from a package; a case an earlier import made is left alone.
  "import_directory_submission_test_cases",
  "send_feedback",
]);

/**
 * Writes a client MAY safely repeat after a dropped response: the identical
 * call lands on the state the first one produced and answers success — not a
 * conflict, not a not-found, and not a second effect. Each was checked against
 * its handler on 2026-10-06:
 *
 * - `delete_project_server` answers `{deleted: true}` again (the soft delete
 *   never checks `deletedAt`).
 * - `cancel_eval_run`, `cancel_goal_run`, `cancel_project_server_connection`
 *   treat an already-cancelled target as a no-op that returns it.
 * - `send_feedback` replays the stored receipt for a key, and dedupes
 *   identical content without one for 24 hours.
 * - `ensure_adhoc_environment` returns the same content-addressed row.
 * - Dismissing, undismissing, re-inviting and archiving a goal set a state
 *   that a repeat sets again; `update_project` writes the same values with no
 *   token to go stale.
 *
 * OPT-IN; absent means `idempotentHint: false`, the conservative claim.
 * Looks idempotent and is not: the compare-and-set edits (`update_client`,
 * `set_client_servers`) answer 409 because the first call rotated the config
 * id; the hard deletes (`delete_eval_suite`, `delete_eval_case`,
 * `uninstall_registry_server`) answer not-found; unpublishing a named study
 * answers not-found; rotating a share link mints another; and anything that
 * runs a third party's tool cannot promise a repeat is harmless.
 */
const IDEMPOTENT_WRITE_NAMES: ReadonlySet<string> = new Set([
  // Saving the plan that is already current changes nothing and answers the
  // saved revision with `replayed: true`, whatever revision it names.
  "save_directory_submission_test_plan",
  // Importing the same plugin version again writes nothing and answers the
  // cases the first import made.
  "import_directory_submission_test_cases",
  "delete_project_server",
  "cancel_eval_run",
  "cancel_goal_run",
  "cancel_project_server_connection",
  "send_feedback",
  "ensure_adhoc_environment",
  "dismiss_swarm_finding",
  "undismiss_swarm_finding",
  "dismiss_study_finding",
  "undismiss_study_finding",
  "upsert_study_member",
  "update_project",
  // The preflight reads the goal by id whether or not it is archived, and the
  // mutation is a no-op on an archived row; a repeat answered
  // `{archived: true}` on production.
  "archive_goal",
]);

export function operationAnnotations(
  operation: PlatformOperation<unknown, unknown>
): ToolAnnotations {
  // The title goes here as well as on the tool: Claude's directory reads a
  // tool's display name from `annotations.title` only, and flags every tool
  // without one even when its top-level `title` is set.
  return { title: operation.title, ...behaviorAnnotations(operation) };
}

function behaviorAnnotations(
  operation: PlatformOperation<unknown, unknown>
): ToolAnnotations {
  if (operation.readOnly) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: !isClosedWorldOperation(operation.name),
    };
  }
  // `mayBeDestructive` operations (call_server_tool, send_chat_message) run
  // the caller's own third-party tools, whose effects nobody upstream can
  // know. They used to omit the hint so clients would assume destructive;
  // Claude's directory wants it stated, so it is stated.
  const additive =
    ADDITIVE_WRITE_NAMES.has(operation.name) &&
    !DESTRUCTIVE_OPERATION_NAMES.has(operation.name) &&
    operation.mayBeDestructive !== true;
  return {
    readOnlyHint: false,
    destructiveHint: !additive,
    idempotentHint: IDEMPOTENT_WRITE_NAMES.has(operation.name),
    openWorldHint: !isClosedWorldOperation(operation.name),
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
