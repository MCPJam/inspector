import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "./types";

export function normalizeRunPassRatePercent(passRate: number): number {
  if (passRate > 0 && passRate <= 1) {
    return Math.round(passRate * 100);
  }
  return Math.round(passRate);
}

type ServerQuality = NonNullable<EvalSuiteRun["serverQuality"]>;
type ToolInsight = ServerQuality["toolInsights"][number];
type WorkflowInsight = ServerQuality["workflowInsights"][number];

export type TriageRow = {
  id: string;
  source: "tool" | "workflow";
  title: string;
  category: "tool description" | "workflow";
  severity: 0 | 1 | 2 | 3;
  affectedCaseKeys: string[];
  failureCount: number;
  rawIssues: string[];
  rawSuggestions: string[];
  toolName?: string;
};

const TOOL_RATING_SEVERITY: Record<ToolInsight["rating"], 0 | 1 | 2 | 3> = {
  poor: 3,
  needs_improvement: 2,
  good: 0,
};

const WORKFLOW_EFFICIENCY_SEVERITY: Record<
  WorkflowInsight["efficiency"],
  0 | 1 | 2 | 3
> = {
  excessive: 3,
  inefficient: 2,
  acceptable: 1,
  optimal: 0,
};

function countTerminalFailedForCaseKeys(
  iterations: EvalIteration[],
  caseKeys: ReadonlySet<string>,
): number {
  if (caseKeys.size === 0) {
    return 0;
  }
  let n = 0;
  for (const it of iterations) {
    const key = it.testCaseSnapshot?.caseKey;
    if (key && caseKeys.has(key) && computeIterationResult(it) === "failed") {
      n += 1;
    }
  }
  return n;
}

function collectAffectedCaseKeysForTool(
  toolName: string,
  workflowInsights: WorkflowInsight[],
): string[] {
  const needle = toolName.toLowerCase();
  const out = new Set<string>();
  for (const w of workflowInsights) {
    if (!w.caseKey) continue;
    const hit =
      (w.issues ?? []).some((s) => s.toLowerCase().includes(needle)) ||
      (w.suggestions ?? []).some((s) => s.toLowerCase().includes(needle));
    if (hit) out.add(w.caseKey);
  }
  return Array.from(out);
}

export function unifyTriageRows({
  serverQuality,
  iterations,
}: {
  serverQuality: ServerQuality | null | undefined;
  iterations: EvalIteration[];
}): TriageRow[] {
  if (!serverQuality) return [];
  const tools = serverQuality.toolInsights ?? [];
  const workflows = serverQuality.workflowInsights ?? [];

  const rows: TriageRow[] = [];

  for (const w of workflows) {
    if (w.efficiency === "optimal") continue;
    const affected = w.caseKey ? [w.caseKey] : [];
    const failureCount = countTerminalFailedForCaseKeys(
      iterations,
      new Set(affected),
    );
    rows.push({
      id: `workflow:${w.caseKey ?? w.title}`,
      source: "workflow",
      title: `Fix workflow for ${w.title}`,
      category: "workflow",
      severity: WORKFLOW_EFFICIENCY_SEVERITY[w.efficiency],
      affectedCaseKeys: affected,
      failureCount,
      rawIssues: w.issues ?? [],
      rawSuggestions: w.suggestions ?? [],
    });
  }

  for (const t of tools) {
    if (t.rating === "good") continue;
    const affected = collectAffectedCaseKeysForTool(t.toolName, workflows);
    const failureCount = countTerminalFailedForCaseKeys(
      iterations,
      new Set(affected),
    );
    rows.push({
      id: `tool:${t.toolName}`,
      source: "tool",
      title: `Improve ${t.toolName}`,
      category: "tool description",
      severity: TOOL_RATING_SEVERITY[t.rating],
      affectedCaseKeys: affected,
      failureCount,
      rawIssues: t.issues ?? [],
      rawSuggestions: t.suggestions ?? [],
      toolName: t.toolName,
    });
  }

  rows.sort((a, b) => {
    if (b.failureCount !== a.failureCount) {
      return b.failureCount - a.failureCount;
    }
    if (b.severity !== a.severity) {
      return b.severity - a.severity;
    }
    if (a.source !== b.source) {
      return a.source === "workflow" ? -1 : 1;
    }
    return 0;
  });

  return rows;
}

export type RunPassFailStats = {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
};

/**
 * Single source of truth for "what does this run's pass/fail breakdown look
 * like right now?". When iterations are loaded, count terminal pass/fail (and
 * ignore pending/running). Otherwise fall back to the persisted summary.
 * Shared by `computeRunDashboardKpis` and the AI triage card so they can't
 * drift.
 */
export function computeRunPassFailStats({
  selectedRunDetails,
  caseGroupsForSelectedRun,
}: {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
}): RunPassFailStats {
  if (caseGroupsForSelectedRun.length === 0) {
    return (
      selectedRunDetails.summary ?? {
        passed: 0,
        failed: 0,
        total: 0,
        passRate: 0,
      }
    );
  }
  const passed = caseGroupsForSelectedRun.filter(
    (i) => computeIterationResult(i) === "passed",
  ).length;
  const failed = caseGroupsForSelectedRun.filter(
    (i) => computeIterationResult(i) === "failed",
  ).length;
  const total = caseGroupsForSelectedRun.length;
  const completed = passed + failed;
  const passRate = completed > 0 ? passed / completed : 0;
  return { passed, failed, total, passRate };
}

/**
 * Pass-rate percent (0–100, integer). When no terminal data exists, returns 0.
 * Use the KPI strip directly if you need to render "—" for the no-data case.
 */
export function computeRunPassRatePercent(args: {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
}): number {
  const stats = computeRunPassFailStats(args);
  return stats.total > 0 ? normalizeRunPassRatePercent(stats.passRate) : 0;
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((s) => `- ${s}`).join("\n") : "- (none)";
}

export function buildFixPrompt(row: TriageRow): string {
  const scopeLine =
    row.source === "tool"
      ? `Tool: ${row.toolName ?? "(unknown)"}`
      : `Case: ${row.affectedCaseKeys.join(", ") || "(unknown)"}`;

  return [
    "Improve the MCP server for the following issue found by an eval run.",
    "",
    `Category: ${row.category}`,
    scopeLine,
    "",
    "Issues identified:",
    bulletList(row.rawIssues),
    "",
    "Suggested changes:",
    bulletList(row.rawSuggestions),
    "",
    "Please update the server (tool descriptions, input schemas, or handler logic) to address these issues. Keep changes minimal and explain what you changed and why.",
  ].join("\n");
}

export function buildTopNPrompt(rows: TriageRow[]): string {
  if (rows.length === 0) return "";
  const header = `The following ${rows.length} issues were found in an eval run. Please address each:`;
  const body = rows.map(buildFixPrompt).join("\n\n---\n\n");
  return `${header}\n\n${body}`;
}
