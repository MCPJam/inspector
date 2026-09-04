import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CellInsightPanel,
  InlineJudgeBadge,
  JudgeVerdictPanel,
  buildJudgeByRunAndCaseKey,
  buildJudgeCaseMap,
  buildWorkflowByRunAndCaseKey,
  caseKeyForGroup,
  deterministicCasePassed,
  judgeDisagreesWithVerdict,
  resolveCellJudge,
  resolveCellWorkflow,
  resolveIterationJudge,
  type JudgeCase,
  type WorkflowInsight,
} from "../goal-completion-presentation";
import type { RunCaseGroup } from "../run-case-groups";
import type { EvalIteration, EvalSuiteRun } from "../types";

function judgeCase(overrides: Partial<JudgeCase> = {}): JudgeCase {
  return {
    caseKey: "case-1",
    score: 0.82,
    passed: true,
    reason: "Added the item to the cart via add_to_cart.",
    rubricHits: [],
    ...overrides,
  };
}

function group(overrides: Partial<RunCaseGroup> = {}): RunCaseGroup {
  return {
    key: "tc-1",
    testCaseId: "tc-1",
    title: "Add to cart",
    model: "gpt",
    iterations: [
      { testCaseSnapshot: { caseKey: "case-1" } } as unknown as EvalIteration,
    ],
    passed: 1,
    failed: 0,
    pending: 0,
    cancelled: 0,
    total: 1,
    p50Ms: null,
    p95Ms: null,
    iterationResults: ["pass"],
    ...overrides,
  };
}

describe("buildJudgeCaseMap", () => {
  it("keys verdicts by caseKey and returns null when nothing is graded", () => {
    const goalCompletion = {
      summary: "",
      generatedAt: 0,
      modelUsed: "m",
      threshold: 0.7,
      cases: [judgeCase({ caseKey: "a" }), judgeCase({ caseKey: "b" })],
    } satisfies EvalSuiteRun["goalCompletion"];
    const map = buildJudgeCaseMap(goalCompletion);
    expect(map?.get("a")?.caseKey).toBe("a");
    expect(map?.get("b")?.caseKey).toBe("b");
    expect(buildJudgeCaseMap(null)).toBeNull();
    expect(
      buildJudgeCaseMap({ ...goalCompletion, cases: [] }),
    ).toBeNull();
  });
});

describe("caseKeyForGroup", () => {
  it("reads the snapshot caseKey, not the group key", () => {
    expect(caseKeyForGroup(group())).toBe("case-1");
    // No snapshot caseKey anywhere → null (don't fall back to group.key).
    expect(
      caseKeyForGroup(
        group({ iterations: [{ testCaseSnapshot: {} } as EvalIteration] }),
      ),
    ).toBeNull();
  });
});

describe("deterministicCasePassed", () => {
  it("is true only when fully passed, null while incomplete", () => {
    expect(deterministicCasePassed(group())).toBe(true);
    expect(
      deterministicCasePassed(group({ passed: 0, failed: 1, iterationResults: ["fail"] })),
    ).toBe(false);
    // Pending → unsettled.
    expect(
      deterministicCasePassed(group({ passed: 0, pending: 1, total: 1 })),
    ).toBeNull();
    // Nothing ran → unsettled.
    expect(deterministicCasePassed(group({ passed: 0, total: 0 }))).toBeNull();
  });
});

describe("judgeDisagreesWithVerdict", () => {
  it("flags only a settled disagreement", () => {
    expect(judgeDisagreesWithVerdict(false, true)).toBe(true); // judge passes a failed case
    expect(judgeDisagreesWithVerdict(true, false)).toBe(true); // judge fails a passed case
    expect(judgeDisagreesWithVerdict(true, true)).toBe(false);
    expect(judgeDisagreesWithVerdict(false, false)).toBe(false);
    // Unsettled either side → never a disagreement.
    expect(judgeDisagreesWithVerdict(null, true)).toBe(false);
    expect(judgeDisagreesWithVerdict(true, undefined)).toBe(false);
  });
});

describe("cross-host cell join (buildJudgeByRunAndCaseKey + resolveCellJudge)", () => {
  const runs = [
    {
      _id: "run-A",
      goalCompletion: {
        summary: "",
        generatedAt: 0,
        modelUsed: "m",
        threshold: 0.7,
        cases: [judgeCase({ caseKey: "case-1", score: 0.9 })],
      },
    },
    {
      _id: "run-B",
      goalCompletion: {
        summary: "",
        generatedAt: 0,
        modelUsed: "m",
        threshold: 0.7,
        cases: [judgeCase({ caseKey: "case-1", score: 0.3, passed: false })],
      },
    },
    { _id: "run-C", goalCompletion: undefined },
  ] as unknown as Parameters<typeof buildJudgeByRunAndCaseKey>[0];

  it("resolves a cell to the verdict from its OWN run, not another host's", () => {
    const map = buildJudgeByRunAndCaseKey(runs);
    const cellA = [
      { suiteRunId: "run-A", testCaseSnapshot: { caseKey: "case-1" } },
    ];
    const cellB = [
      { suiteRunId: "run-B", testCaseSnapshot: { caseKey: "case-1" } },
    ];
    expect(resolveCellJudge(cellA, map)?.score).toBe(0.9);
    expect(resolveCellJudge(cellB, map)?.score).toBe(0.3);
  });

  it("returns undefined for an ungraded run or missing keys", () => {
    const map = buildJudgeByRunAndCaseKey(runs);
    expect(
      resolveCellJudge(
        [{ suiteRunId: "run-C", testCaseSnapshot: { caseKey: "case-1" } }],
        map,
      ),
    ).toBeUndefined();
    expect(
      resolveCellJudge([{ suiteRunId: "run-A" }], map),
    ).toBeUndefined();
    expect(resolveCellJudge([], map)).toBeUndefined();
    expect(resolveCellJudge([{ suiteRunId: "run-A" }], null)).toBeUndefined();
  });
});

describe("resolveIterationJudge (case drill-in join)", () => {
  const runs = [
    {
      _id: "run-A",
      goalCompletion: {
        summary: "",
        generatedAt: 0,
        modelUsed: "m",
        threshold: 0.7,
        cases: [judgeCase({ caseKey: "case-1", score: 0.42, passed: false })],
      },
    },
  ] as unknown as Parameters<typeof resolveIterationJudge>[1];

  it("joins an iteration to its run's verdict by caseKey", () => {
    const verdict = resolveIterationJudge(
      { suiteRunId: "run-A", testCaseSnapshot: { caseKey: "case-1" } },
      runs,
    );
    expect(verdict?.score).toBe(0.42);
  });

  it("returns null when the run is unjudged or join keys are missing", () => {
    expect(
      resolveIterationJudge(
        { suiteRunId: "run-Z", testCaseSnapshot: { caseKey: "case-1" } },
        runs,
      ),
    ).toBeNull();
    expect(resolveIterationJudge({ suiteRunId: "run-A" }, runs)).toBeNull();
    expect(resolveIterationJudge(null, runs)).toBeNull();
  });

  /**
   * S6 — a repeated case has one verdict PER TRIAL, and `caseKey` names the
   * case rather than the trial.
   *
   * Under verdict policy v2 every case runs several times, so a `caseKey` join
   * returns whichever trial's verdict happens to be first in the array and
   * attributes it to whichever trial the reader is looking at. That is not a
   * missing verdict — it is the wrong one, shown confidently, next to a
   * transcript that disagrees with it.
   */
  describe("a case that ran more than once", () => {
    const repeated = [
      {
        _id: "run-A",
        goalCompletion: {
          summary: "",
          generatedAt: 0,
          modelUsed: "m",
          threshold: 0.7,
          cases: [
            judgeCase({
              caseKey: "case-1",
              gradingKey: "case-1#1",
              iterationId: "it-1",
              score: 0.1,
              passed: false,
            }),
            judgeCase({
              caseKey: "case-1",
              gradingKey: "case-1#2",
              iterationId: "it-2",
              score: 0.9,
              passed: true,
            }),
          ],
        },
      },
    ] as unknown as Parameters<typeof resolveIterationJudge>[1];

    it("joins on the iteration id when the backend resolved one", () => {
      expect(
        resolveIterationJudge(
          {
            _id: "it-2",
            suiteRunId: "run-A",
            iterationNumber: 2,
            testCaseSnapshot: { caseKey: "case-1" },
          },
          repeated,
        )?.score,
      ).toBe(0.9);
    });

    it("falls back to the grading key, not to the case key", () => {
      // No `_id` on the iteration, so the id join cannot fire — and a caseKey
      // join here would return trial 1's 0.1 for trial 2.
      expect(
        resolveIterationJudge(
          {
            suiteRunId: "run-A",
            iterationNumber: 2,
            testCaseSnapshot: { caseKey: "case-1" },
          },
          repeated,
        )?.score,
      ).toBe(0.9);
    });

    it("returns null on a keyed run when this trial has no verdict", () => {
      // Trial 3 was skipped, errored, or is not yet graded: the run carries
      // trial keys, so a miss is the answer. A `caseKey` join here would show
      // trial 1's 0.1 as trial 3's — and let a reviewer label it.
      expect(
        resolveIterationJudge(
          {
            _id: "it-3",
            suiteRunId: "run-A",
            iterationNumber: 3,
            testCaseSnapshot: { caseKey: "case-1" },
          },
          repeated,
        ),
      ).toBeNull();
    });

    it("still joins a legacy run by caseKey alone", () => {
      // Runs judged before either key existed carry neither, and on those
      // `caseKey` is exactly what their verdicts were keyed by.
      expect(
        resolveIterationJudge(
          {
            _id: "it-9",
            suiteRunId: "run-A",
            iterationNumber: 7,
            testCaseSnapshot: { caseKey: "case-1" },
          },
          runs,
        )?.score,
      ).toBe(0.42);
    });
  });
});

describe("JudgeVerdictPanel", () => {
  it("renders a compact strip: label, score, verdict, and reason preview", () => {
    render(
      <JudgeVerdictPanel
        judgeCase={judgeCase({
          score: 0.42,
          passed: false,
          reason: "Cart was never updated.",
          rubricHits: ["missing: add_to_cart"],
        })}
      />,
    );
    expect(screen.getByText(/Judge · advisory/i)).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("below threshold")).toBeInTheDocument();
    expect(screen.getByText("Cart was never updated.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand judge reason/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("expands to show the full reason on click", async () => {
    const user = userEvent.setup();
    render(
      <JudgeVerdictPanel
        judgeCase={judgeCase({
          score: 0,
          passed: false,
          reason:
            "The agent only searched grocery/pasta and did not show an empty cart after a clear-cart action.",
        })}
      />,
    );
    const toggle = screen.getByRole("button", { name: /expand judge reason/i });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(
        "The agent only searched grocery/pasta and did not show an empty cart after a clear-cart action.",
      ),
    ).toBeInTheDocument();
  });

  it("strips the 'no rubric:' jargon and shows a friendly tag", () => {
    render(
      <JudgeVerdictPanel
        judgeCase={judgeCase({
          score: 0.8,
          passed: true,
          reason: "no rubric: plausibly showed a Red Bull product.",
        })}
      />,
    );
    expect(screen.getByText(/no expected output/i)).toBeInTheDocument();
    expect(
      screen.getByText("plausibly showed a Red Bull product."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no rubric:/i)).not.toBeInTheDocument();
  });
});

describe("cross-host workflow join (buildWorkflowByRunAndCaseKey + resolveCellWorkflow)", () => {
  const workflow = (
    overrides: Partial<WorkflowInsight> = {},
  ): WorkflowInsight =>
    ({
      caseKey: "case-1",
      title: "Add to cart",
      toolCallCount: 5,
      efficiency: "inefficient",
      issues: ["Searched repeatedly without adding to cart."],
      suggestions: ["Call add_to_cart after the first relevant result."],
      ...overrides,
    }) as WorkflowInsight;

  const runs = [
    { _id: "run-A", serverQuality: { workflowInsights: [workflow()] } },
    { _id: "run-B", serverQuality: undefined },
  ] as unknown as Parameters<typeof buildWorkflowByRunAndCaseKey>[0];

  it("resolves a cell to its own run's workflow finding", () => {
    const map = buildWorkflowByRunAndCaseKey(runs);
    expect(
      resolveCellWorkflow(
        [{ suiteRunId: "run-A", testCaseSnapshot: { caseKey: "case-1" } }],
        map,
      )?.efficiency,
    ).toBe("inefficient");
    expect(
      resolveCellWorkflow(
        [{ suiteRunId: "run-B", testCaseSnapshot: { caseKey: "case-1" } }],
        map,
      ),
    ).toBeUndefined();
  });
});

describe("CellInsightPanel", () => {
  it("renders the judge verdict, the workflow finding, and a trace link", async () => {
    const user = userEvent.setup();
    const onOpenTrace = vi.fn();
    render(
      <CellInsightPanel
        judgeCase={judgeCase({
          score: 0.55,
          passed: false,
          reason: "Final answer reported Coke instead of Red Bull.",
        })}
        workflowInsight={
          {
            caseKey: "case-1",
            title: "Show me a redbull",
            toolCallCount: 4,
            efficiency: "inefficient",
            issues: ["Over-searched before viewing the cart."],
            suggestions: ["View the cart directly after adding."],
          } as WorkflowInsight
        }
        onOpenTrace={onOpenTrace}
      />,
    );
    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(
      screen.getByText("Final answer reported Coke instead of Red Bull."),
    ).toBeInTheDocument();
    expect(screen.getByText("inefficient")).toBeInTheDocument();
    expect(
      screen.getByText("Over-searched before viewing the cart."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /view trace/i }));
    expect(onOpenTrace).toHaveBeenCalledTimes(1);
  });
});

describe("InlineJudgeBadge", () => {
  it("renders only the score; verdict + reason live in the tooltip", () => {
    render(<InlineJudgeBadge judgeCase={judgeCase()} disagrees={false} />);
    const score = screen.getByText("82%");
    expect(score).toBeInTheDocument();
    // The verdict word is NOT inline (kept minimal) — it's in the tooltip.
    expect(screen.queryByText("meets goal")).not.toBeInTheDocument();
    const badge = score.parentElement;
    expect(badge?.title).toContain("meets goal");
    expect(badge?.title).toContain("Added the item to the cart");
  });

  it("marks disagreement with ≠ and notes it in the tooltip + aria-label", () => {
    render(
      <InlineJudgeBadge
        judgeCase={judgeCase({ passed: false, score: 0.48 })}
        disagrees
      />,
    );
    const score = screen.getByText("48%");
    expect(score).toBeInTheDocument();
    const badge = score.parentElement;
    expect(badge?.textContent).toContain("≠");
    expect(badge?.title).toContain("disagrees with the deterministic pass/fail");
    expect(badge?.getAttribute("aria-label")).toContain(
      "disagrees with pass/fail",
    );
  });
});
