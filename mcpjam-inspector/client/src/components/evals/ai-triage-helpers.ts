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
  /** Arcade pattern slug the judge attributed the violation to, if any. */
  patternSlug?: string;
  /** PR-B auditability metadata carried through from the judge insight. */
  evidence?: string[];
  confidence?: ToolInsight["confidence"];
  attribution?: ToolInsight["attribution"];
};

/** Pre-resolved tool definition embedded in a fix prompt so the coding agent
 * has the current shape to edit against. Callers do the lookup against the
 * snapshot (via `getInspectionRevisionById`) before invoking `buildFixPrompt`. */
export type EmbeddableTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

const ARCADE_PATTERNS_BASE_URL = "https://arcade.dev/patterns";

// SYNC: these weights mirror the backend source of truth at
// mcpjam-backend/convex/lib/serverQualityScore.ts. They live in a separate repo
// so they cannot be imported across; a literal-value test pins both sides. If
// you change a weight here, change it there too (and vice versa).
export const TOOL_RATING_SEVERITY: Record<
  ToolInsight["rating"],
  0 | 1 | 2 | 3
> = {
  poor: 3,
  needs_improvement: 2,
  good: 0,
};

export const WORKFLOW_EFFICIENCY_SEVERITY: Record<
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
  const needle = toolName.trim().toLowerCase();
  if (!needle) return [];
  const out = new Set<string>();
  for (const w of workflowInsights) {
    if (!w.caseKey) continue;
    // Optimal workflows are filtered out of triage rows; their text must not
    // attribute case failures to a tool either.
    if (w.efficiency === "optimal") continue;
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
  const idCounts = new Map<string, number>();
  const uniqueId = (base: string): string => {
    const n = idCounts.get(base) ?? 0;
    idCounts.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  };

  for (const w of workflows) {
    if (w.efficiency === "optimal") continue;
    const affected = w.caseKey ? [w.caseKey] : [];
    const failureCount = countTerminalFailedForCaseKeys(
      iterations,
      new Set(affected),
    );
    rows.push({
      id: uniqueId(`workflow:${w.caseKey ?? w.title ?? "untitled"}`),
      source: "workflow",
      title: `Fix workflow for ${w.title}`,
      category: "workflow",
      severity: WORKFLOW_EFFICIENCY_SEVERITY[w.efficiency],
      affectedCaseKeys: affected,
      failureCount,
      rawIssues: w.issues ?? [],
      rawSuggestions: w.suggestions ?? [],
      patternSlug: w.patternSlug,
      evidence: w.evidence,
      confidence: w.confidence,
      attribution: w.attribution,
    });
  }

  for (const t of tools) {
    if (t.rating === "good") continue;
    if (!t.toolName?.trim()) continue;
    const affected = collectAffectedCaseKeysForTool(t.toolName, workflows);
    const failureCount = countTerminalFailedForCaseKeys(
      iterations,
      new Set(affected),
    );
    rows.push({
      id: uniqueId(`tool:${t.toolName}`),
      source: "tool",
      title: `Improve ${t.toolName}`,
      category: "tool description",
      severity: TOOL_RATING_SEVERITY[t.rating],
      affectedCaseKeys: affected,
      failureCount,
      rawIssues: t.issues ?? [],
      rawSuggestions: t.suggestions ?? [],
      toolName: t.toolName,
      patternSlug: t.patternSlug,
      evidence: t.evidence,
      confidence: t.confidence,
      attribution: t.attribution,
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

function renderEmbeddableTool(tool: EmbeddableTool): string {
  const lines: string[] = [`### \`${tool.name}\``];
  lines.push(
    `Current description: ${tool.description?.trim() || "_(no description)_"}`,
  );
  if (tool.inputSchema !== undefined) {
    lines.push("Current inputSchema:");
    lines.push("```json");
    lines.push(JSON.stringify(tool.inputSchema, null, 2));
    lines.push("```");
  }
  return lines.join("\n");
}

export type BuildFixPromptOptions = {
  /** Tools to embed verbatim so the coding agent has the current shape to
   * edit against. For tool rows, pass the single tool. For workflow rows,
   * pass every tool actually used in the workflow's iteration. */
  embedTools?: EmbeddableTool[];
};

export function buildFixPrompt(
  row: TriageRow,
  options?: BuildFixPromptOptions,
): string {
  const scopeLine =
    row.source === "tool"
      ? `Tool: ${row.toolName ?? "(unknown)"}`
      : `Case: ${row.affectedCaseKeys.join(", ") || "(unknown)"}`;

  const sections: string[] = [
    "Improve the MCP server for the following issue found by an eval run.",
    "",
    `Category: ${row.category}`,
    scopeLine,
  ];

  if (row.confidence) {
    sections.push(`Judge confidence: ${row.confidence}`);
  }
  if (row.attribution && row.attribution !== "server_design") {
    sections.push(
      `> Attribution: ${row.attribution} — this finding may reflect agent or test-harness behavior rather than a server defect. Verify against the trace before changing server code.`,
    );
  }

  if (row.patternSlug) {
    sections.push(
      `Pattern: ${row.patternSlug}`,
      `Reference: ${ARCADE_PATTERNS_BASE_URL}/${row.patternSlug}`,
    );
  }

  if (row.evidence && row.evidence.length > 0) {
    sections.push("", "Evidence:", bulletList(row.evidence));
  }

  sections.push("", "Issues identified:", bulletList(row.rawIssues));
  sections.push("", "Suggested changes:", bulletList(row.rawSuggestions));

  if (options?.embedTools && options.embedTools.length > 0) {
    sections.push("", "Current tool definition(s) — edit these:");
    sections.push("");
    for (const tool of options.embedTools) {
      sections.push(renderEmbeddableTool(tool));
    }
  }

  sections.push(
    "",
    "Please update the server (tool descriptions, input schemas, or handler logic) to address these issues. Keep changes minimal and explain what you changed and why.",
  );

  return sections.join("\n");
}

export type BuildTopNPromptOptions = {
  /** Per-row embed-tool overrides. Maps `TriageRow.id` to its tools. */
  embedToolsByRowId?: Record<string, EmbeddableTool[]>;
};

export function buildTopNPrompt(
  rows: TriageRow[],
  options?: BuildTopNPromptOptions,
): string {
  if (rows.length === 0) return "";
  const header = `The following ${rows.length} issues were found in an eval run. Please address each:`;
  const body = rows
    .map((row) =>
      buildFixPrompt(row, {
        embedTools: options?.embedToolsByRowId?.[row.id],
      }),
    )
    .join("\n\n---\n\n");
  return `${header}\n\n${body}`;
}
