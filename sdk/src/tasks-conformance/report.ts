import {
  buildConformanceProfileStamp,
  conformanceProfile,
  partitionByProfile,
} from "../conformance-profile.js";
import {
  buildOutcomeSummary,
  decideConformanceOutcome,
} from "../conformance-outcome.js";
import { CHECK_METADATA } from "./check-metadata.js";
import { summarizeChecks } from "./check-summary.js";
import {
  MCP_TASKS_CHECK_IDS,
  isTasksToolCheck,
  type MCPTasksCheckId,
  type MCPTasksCheckResult,
  type MCPTasksConformanceResult,
} from "./types.js";

export function taskGroupFailure(
  checkIds: MCPTasksCheckId[],
  message: string,
  target: string,
  toolName?: string
): MCPTasksConformanceResult {
  const checks: MCPTasksCheckResult[] = checkIds.map((id) => ({
    ...CHECK_METADATA[id],
    status: "skipped",
    skipReason: "could-not-run",
    durationMs: 0,
    error: { message },
    ...(toolName && isTasksToolCheck(id) ? { details: { toolName } } : {}),
  }));
  return {
    passed: false,
    outcome: "incomplete",
    target,
    checks,
    summary: buildOutcomeSummary(checks),
    durationMs: 0,
    categorySummary: summarizeChecks(checks),
    discovery: {
      wire: "none",
      toolCount: 0,
      taskCapableToolCount: 0,
      ...(toolName ? { probedTool: toolName } : {}),
    },
  };
}

/** Score the selected checks once, irrespective of how many sessions observed them. */
export function mergeTasksConformanceResults(
  results: MCPTasksConformanceResult[],
  selected: readonly MCPTasksCheckId[] = MCP_TASKS_CHECK_IDS,
  durationMs?: number
): MCPTasksConformanceResult {
  const checks: MCPTasksCheckResult[] = [...new Set(selected)].map((id) => {
    const observations = results.flatMap((r) =>
      r.checks.filter((c) => c.id === id)
    );
    if (!observations.length)
      return {
        ...CHECK_METADATA[id],
        status: "skipped",
        skipReason: "could-not-run",
        durationMs: 0,
        error: { message: "The selected check produced no result." },
      };
    const chosen =
      observations.find((c) => c.status === "failed") ??
      observations.find((c) => c.skipReason === "could-not-run") ??
      observations.find((c) => c.status === "passed") ??
      observations[0]!;
    if (id !== "tasks-declaration-hygiene") return chosen;
    return {
      ...chosen,
      durationMs: observations.reduce((sum, c) => sum + c.durationMs, 0),
      details: {
        ...chosen.details,
        inspectedRequests: observations.reduce(
          (sum, c) => sum + Number(c.details?.inspectedRequests ?? 0),
          0
        ),
      },
    };
  });
  const profile = conformanceProfile("mcp-tasks");
  const { scored, pending } = partitionByProfile(checks, profile);
  const verdict =
    scored.length === 0 && pending.length > 0
      ? {
          outcome: "incomplete" as const,
          incompleteReason: `all ${pending.length} selected check(s) ran but are unscored by profile ${profile.id}@${profile.version}, so this run establishes no conformance verdict`,
        }
      : decideConformanceOutcome(scored);
  const readiness = results
    .flatMap((r) => r.readiness ?? [])
    .filter((r, i, all) => all.findIndex((other) => other.id === r.id) === i);
  const uncheckedAdvice = results
    .flatMap((r) => r.uncheckedAdvice ?? [])
    .filter(
      (r, i, all) =>
        !readiness.some((other) => other.id === r.id) &&
        all.findIndex((other) => other.id === r.id) === i
    );
  const discovery = results.find((r) => r.discovery.protocolVersion)
    ?.discovery ??
    results[0]?.discovery ?? {
      wire: "none" as const,
      toolCount: 0,
      taskCapableToolCount: 0,
    };
  const toolNames = new Set(
    results.map((r) => r.discovery.probedTool).filter(Boolean)
  );
  const taskIds = new Set(
    results.map((r) => r.discovery.createdTaskId).filter(Boolean)
  );
  const { probedTool, createdTaskId, ...common } = discovery;
  return {
    ...verdict,
    passed: verdict.outcome === "passed",
    target: results[0]?.target ?? "",
    checks,
    summary:
      buildOutcomeSummary(scored) +
      (pending.length
        ? `, ${pending.length} pending (unscored by profile ${profile.id}@${profile.version})`
        : ""),
    durationMs: durationMs ?? results.reduce((sum, r) => sum + r.durationMs, 0),
    categorySummary: summarizeChecks(checks),
    profile: buildConformanceProfileStamp({
      profile,
      checks,
      ...(discovery.protocolVersion
        ? { protocolVersion: discovery.protocolVersion }
        : {}),
    }),
    discovery: {
      ...common,
      toolCount: Math.max(
        0,
        ...results.map((result) => result.discovery.toolCount)
      ),
      taskCapableToolCount: Math.max(
        0,
        ...results.map((result) => result.discovery.taskCapableToolCount)
      ),
      ...(toolNames.size === 1 ? { probedTool: [...toolNames][0] } : {}),
      ...(taskIds.size === 1 ? { createdTaskId: [...taskIds][0] } : {}),
    },
    ...(readiness.length ? { readiness } : {}),
    ...(uncheckedAdvice.length ? { uncheckedAdvice } : {}),
  };
}
