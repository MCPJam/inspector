import { describe, it, expect } from "vitest";
import type { EvalIteration, EvalSuiteRun } from "../types";
import {
  buildFixPrompt,
  buildTopNPrompt,
  computeRunPassRatePercent,
  unifyTriageRows,
  type TriageRow,
} from "../ai-triage-helpers";

type ServerQuality = NonNullable<EvalSuiteRun["serverQuality"]>;
type ToolInsight = ServerQuality["toolInsights"][number];
type WorkflowInsight = ServerQuality["workflowInsights"][number];

const baseRun: EvalSuiteRun = {
  _id: "run-1",
  suiteId: "suite-1",
  createdBy: "user",
  runNumber: 1,
  configRevision: "rev1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed",
  createdAt: 1,
  completedAt: 2,
  summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
};

function iter(
  caseKey: string,
  status: EvalIteration["status"],
  result: EvalIteration["result"],
  resultSource: EvalIteration["resultSource"] = "reported",
): EvalIteration {
  return {
    _id: `it-${caseKey}-${Math.random().toString(36).slice(2, 7)}`,
    testCaseSnapshot: {
      caseKey,
      title: caseKey,
      query: "q",
      provider: "openai",
      model: "gpt",
      expectedToolCalls: [],
    },
    createdBy: "user",
    createdAt: 0,
    iterationNumber: 0,
    updatedAt: 0,
    status,
    result,
    actualToolCalls: [],
    tokensUsed: 0,
    resultSource,
  };
}

function tool(
  toolName: string,
  rating: ToolInsight["rating"],
  issues: string[] = [],
  suggestions: string[] = [],
): ToolInsight {
  return { toolName, rating, issues, suggestions };
}

function workflow(
  caseKey: string,
  efficiency: WorkflowInsight["efficiency"],
  issues: string[] = [],
  suggestions: string[] = [],
  title = caseKey,
  toolCallCount = 0,
): WorkflowInsight {
  return { caseKey, title, toolCallCount, efficiency, issues, suggestions };
}

function makeServerQuality(
  toolInsights: ToolInsight[],
  workflowInsights: WorkflowInsight[],
): ServerQuality {
  return {
    summary: "",
    generatedAt: 0,
    modelUsed: "m",
    toolInsights,
    workflowInsights,
  };
}

describe("unifyTriageRows", () => {
  it("filters out good tools and optimal workflows", () => {
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality(
        [tool("good_tool", "good"), tool("bad_tool", "poor")],
        [workflow("c1", "optimal"), workflow("c2", "inefficient")],
      ),
      iterations: [],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["tool:bad_tool", "workflow:c2"].sort(),
    );
  });

  it("counts only terminal-failed iterations for workflow rows", () => {
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality(
        [],
        [workflow("c1", "inefficient")],
      ),
      iterations: [
        iter("c1", "failed", "failed"),
        iter("c1", "failed", "failed"),
        iter("c1", "pending", "pending"),
        iter("c1", "completed", "passed"),
        iter("c2", "failed", "failed"),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].failureCount).toBe(2);
    expect(rows[0].affectedCaseKeys).toEqual(["c1"]);
  });

  it("derives tool-row failure count via case-insensitive substring match against workflow issues/suggestions", () => {
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality(
        [tool("search_tasks", "needs_improvement")],
        [
          workflow(
            "c1",
            "inefficient",
            ["Calls SEARCH_TASKS too many times"],
            [],
          ),
          workflow("c2", "inefficient", [], ["use Search_Tasks differently"]),
          workflow("c3", "inefficient", ["unrelated"], []),
        ],
      ),
      iterations: [
        iter("c1", "failed", "failed"),
        iter("c1", "completed", "passed"),
        iter("c2", "failed", "failed"),
        iter("c3", "failed", "failed"),
      ],
    });
    const toolRow = rows.find((r) => r.source === "tool")!;
    expect(toolRow.affectedCaseKeys.sort()).toEqual(["c1", "c2"]);
    expect(toolRow.failureCount).toBe(2);
  });

  it("returns failureCount 0 when no workflow row mentions the tool", () => {
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality(
        [tool("orphan_tool", "poor")],
        [workflow("c1", "inefficient", ["unrelated text"], [])],
      ),
      iterations: [iter("c1", "failed", "failed")],
    });
    const toolRow = rows.find((r) => r.source === "tool")!;
    expect(toolRow.affectedCaseKeys).toEqual([]);
    expect(toolRow.failureCount).toBe(0);
  });

  it("sort ordering exact: (failureCount desc, severity desc, workflow-before-tool)", () => {
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality(
        [
          tool("t_hi", "poor"), // sev 3
          tool("t_lo", "needs_improvement"), // sev 2
        ],
        [
          workflow("c1", "excessive"), // sev 3, 3 fail
          workflow("c2", "acceptable"), // sev 1, 1 fail
          workflow("c3", "inefficient"), // sev 2, 0 fail
        ],
      ),
      iterations: [
        iter("c1", "failed", "failed"),
        iter("c1", "failed", "failed"),
        iter("c1", "failed", "failed"),
        iter("c2", "failed", "failed"),
      ],
    });
    const ids = rows.map((r) => r.id);
    // Top: c1 (3 fail). Then c2 (1 fail). Then 0-fail group ordered by severity desc:
    //   t_hi sev 3, then tie at sev 2 → workflow c3 before tool t_lo.
    expect(ids).toEqual([
      "workflow:c1",
      "workflow:c2",
      "tool:t_hi",
      "workflow:c3",
      "tool:t_lo",
    ]);
  });

  it("returns [] when serverQuality is null or undefined", () => {
    expect(unifyTriageRows({ serverQuality: null, iterations: [] })).toEqual(
      [],
    );
    expect(
      unifyTriageRows({ serverQuality: undefined, iterations: [] }),
    ).toEqual([]);
  });
});

describe("computeRunPassRatePercent", () => {
  it("falls back to summary.passRate when no iterations loaded", () => {
    const run: EvalSuiteRun = {
      ...baseRun,
      summary: { total: 10, passed: 7, failed: 3, passRate: 0.7 },
    };
    expect(
      computeRunPassRatePercent({
        selectedRunDetails: run,
        caseGroupsForSelectedRun: [],
      }),
    ).toBe(70);
  });

  it("returns 0 when summary.total is 0 and no iterations", () => {
    expect(
      computeRunPassRatePercent({
        selectedRunDetails: baseRun,
        caseGroupsForSelectedRun: [],
      }),
    ).toBe(0);
  });

  it("computes from terminal pass/fail when iterations are present, ignoring pending", () => {
    expect(
      computeRunPassRatePercent({
        selectedRunDetails: baseRun,
        caseGroupsForSelectedRun: [
          iter("c1", "completed", "passed"),
          iter("c1", "completed", "passed"),
          iter("c1", "failed", "failed"),
          iter("c1", "pending", "pending"),
        ],
      }),
    ).toBe(67); // 2/3 rounded
  });
});

describe("buildFixPrompt", () => {
  const baseRow: TriageRow = {
    id: "tool:foo",
    source: "tool",
    title: "Improve foo",
    category: "tool description",
    severity: 3,
    affectedCaseKeys: ["c1"],
    failureCount: 1,
    rawIssues: ["issue 1", "issue 2"],
    rawSuggestions: ["do x", "do y"],
    toolName: "foo",
  };

  it("renders issue + suggestion bullets", () => {
    const text = buildFixPrompt(baseRow);
    expect(text).toContain("- issue 1");
    expect(text).toContain("- do y");
  });

  it("does not emit '- undefined' when issues/suggestions are empty", () => {
    const text = buildFixPrompt({
      ...baseRow,
      rawIssues: [],
      rawSuggestions: [],
    });
    expect(text).not.toContain("undefined");
    expect(text).toContain("- (none)");
  });
});

describe("buildFixPrompt embedTools", () => {
  const baseRow: TriageRow = {
    id: "tool:foo",
    source: "tool",
    title: "Improve foo",
    category: "tool description",
    severity: 3,
    affectedCaseKeys: [],
    failureCount: 0,
    rawIssues: ["x"],
    rawSuggestions: ["y"],
    toolName: "foo",
  };

  it("embeds current tool description + inputSchema when embedTools is provided", () => {
    const text = buildFixPrompt(baseRow, {
      embedTools: [
        {
          name: "foo",
          description: "Does the foo thing",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
    });
    expect(text).toContain("### `foo`");
    expect(text).toContain("Current description: Does the foo thing");
    expect(text).toContain('"type": "object"');
  });

  it("falls back to '(no description)' for a tool without a description", () => {
    const text = buildFixPrompt(baseRow, {
      embedTools: [{ name: "foo" }],
    });
    expect(text).toContain("_(no description)_");
  });

  it("propagates patternSlug through unifyTriageRows", () => {
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality(
        [
          {
            toolName: "t",
            rating: "poor",
            issues: [],
            suggestions: [],
            patternSlug: "recovery-guide",
          } as ToolInsight,
        ],
        [
          {
            caseKey: "c1",
            title: "c1",
            toolCallCount: 0,
            efficiency: "inefficient",
            issues: [],
            suggestions: [],
            patternSlug: "task-bundle",
          } as WorkflowInsight,
        ],
      ),
      iterations: [],
    });
    const toolRow = rows.find((r) => r.source === "tool")!;
    const workflowRow = rows.find((r) => r.source === "workflow")!;
    expect(toolRow.patternSlug).toBe("recovery-guide");
    expect(workflowRow.patternSlug).toBe("task-bundle");
  });
});

describe("buildTopNPrompt", () => {
  it("returns '' for empty rows", () => {
    expect(buildTopNPrompt([])).toBe("");
  });

  it("threads embedToolsByRowId to the right row", () => {
    const rows: TriageRow[] = [
      {
        id: "tool:foo",
        source: "tool",
        title: "Improve foo",
        category: "tool description",
        severity: 3,
        affectedCaseKeys: [],
        failureCount: 0,
        rawIssues: [],
        rawSuggestions: [],
        toolName: "foo",
      },
      {
        id: "tool:bar",
        source: "tool",
        title: "Improve bar",
        category: "tool description",
        severity: 2,
        affectedCaseKeys: [],
        failureCount: 0,
        rawIssues: [],
        rawSuggestions: [],
        toolName: "bar",
      },
    ];
    const text = buildTopNPrompt(rows, {
      embedToolsByRowId: {
        "tool:foo": [{ name: "foo", description: "the foo" }],
      },
    });
    expect(text).toContain("Current description: the foo");
    // bar has no embed → no description block
    expect(text.split("### `bar`").length).toBe(1);
  });

  it("joins multiple prompts with separator and header", () => {
    const rows: TriageRow[] = [
      {
        id: "a",
        source: "tool",
        title: "t",
        category: "tool description",
        severity: 3,
        affectedCaseKeys: [],
        failureCount: 0,
        rawIssues: ["a"],
        rawSuggestions: [],
        toolName: "a",
      },
      {
        id: "b",
        source: "workflow",
        title: "t",
        category: "workflow",
        severity: 2,
        affectedCaseKeys: ["c"],
        failureCount: 1,
        rawIssues: ["b"],
        rawSuggestions: [],
      },
    ];
    const text = buildTopNPrompt(rows);
    expect(text.startsWith("The following 2 issues")).toBe(true);
    expect(text.split("---").length).toBe(2);
  });
});

describe("PR-B metadata: unifyTriageRows propagation", () => {
  it("carries evidence/confidence/attribution from insights to rows", () => {
    const toolInsight: ToolInsight = {
      ...tool("bad_tool", "poor", ["i"]),
      evidence: ["inputSchema missing"],
      confidence: "high",
      attribution: "server_design",
    };
    const wfInsight: WorkflowInsight = {
      ...workflow("c1", "inefficient", ["w"]),
      confidence: "low",
      attribution: "agent_behavior",
    };
    const rows = unifyTriageRows({
      serverQuality: makeServerQuality([toolInsight], [wfInsight]),
      iterations: [],
    });
    expect(rows.find((r) => r.source === "tool")).toMatchObject({
      evidence: ["inputSchema missing"],
      confidence: "high",
      attribution: "server_design",
    });
    expect(rows.find((r) => r.source === "workflow")).toMatchObject({
      confidence: "low",
      attribution: "agent_behavior",
    });
  });
});

describe("PR-B metadata: buildFixPrompt", () => {
  const baseRow: TriageRow = {
    id: "tool:x",
    source: "tool",
    title: "Improve x",
    category: "tool description",
    severity: 3,
    affectedCaseKeys: [],
    failureCount: 0,
    rawIssues: ["i"],
    rawSuggestions: ["s"],
    toolName: "x",
  };

  it("warns when attribution is not server_design", () => {
    const text = buildFixPrompt({ ...baseRow, attribution: "agent_behavior" });
    expect(text).toContain("Attribution: agent_behavior");
    expect(text).toContain("Verify against the trace");
  });

  it("does not warn for a corroborated server_design row", () => {
    const text = buildFixPrompt({ ...baseRow, attribution: "server_design" });
    expect(text).not.toContain("Attribution:");
  });

  it("renders confidence and an evidence section", () => {
    const text = buildFixPrompt({
      ...baseRow,
      confidence: "low",
      evidence: ["the schema is missing", "errors are opaque"],
    });
    expect(text).toContain("Judge confidence: low");
    expect(text).toContain("Evidence:");
    expect(text).toContain("- the schema is missing");
  });

  it("is unchanged for legacy rows without metadata", () => {
    const text = buildFixPrompt(baseRow);
    expect(text).not.toContain("Attribution:");
    expect(text).not.toContain("Judge confidence:");
    expect(text).not.toContain("Evidence:");
  });
});
