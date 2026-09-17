import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalIteration } from "@/components/evals/types";
import { TrialScorecard, summaryLine } from "../case-scorecard/trial-scorecard";
import type { CaseScorecardInput } from "../case-scorecard/case-scorecard-model";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import { PASS_WORDS } from "./pass-words";

const steps: TestStep[] = [
  { id: "s1", kind: "prompt", prompt: "Who am I signed in as?" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "toolCalledAtLeastOnce", toolName: "get_me" },
  },
  { id: "a2", kind: "assert", assertion: { type: "noToolErrors" } },
];

const authored: CaseScorecardInput = {
  steps,
  toolsChoice: "unset",
  predicates: {
    mode: "extend",
    list: [{ type: "finalAssistantMessageNonEmpty" } as Predicate],
  },
};

function iteration(metadata: Record<string, unknown> = {}): EvalIteration {
  return {
    _id: "it1",
    status: "completed",
    result: "passed",
    metadata,
  } as unknown as EvalIteration;
}

function renderCard(
  overrides: Partial<Parameters<typeof TrialScorecard>[0]> = {},
) {
  return render(
    <TrialScorecard
      authored={authored}
      iteration={iteration()}
      steps={steps}
      {...overrides}
    />,
  );
}

const rowFor = (label: string) =>
  screen
    .getAllByTestId("trial-scorecard-row")
    .find((row) => row.textContent?.includes(label))!;

describe("TrialScorecard", () => {
  it.each(["pending", "running"] as const)(
    "withholds stage results while %s and reveals them when complete",
    (status) => {
      const chain = {
        status: "verified",
        stages: [{ stage: "connection", state: "passed", reason: "observed" }],
      } as never;
      const { rerender } = renderCard({
        iteration: { ...iteration(), status },
        chain,
      });
      expect(screen.getByTestId("trial-scorecard-loading")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(screen.queryByTestId("trial-chain-panel")).toBeNull();
      expect(screen.queryByTestId("trial-scorecard-row")).toBeNull();
      rerender(
        <TrialScorecard
          authored={authored}
          iteration={iteration()}
          steps={steps}
          chain={chain}
        />,
      );
      expect(screen.queryByTestId("trial-scorecard-loading")).toBeNull();
      expect(screen.getByTestId("trial-chain-panel")).toBeInTheDocument();
    },
  );
  it("shows a skeleton before a live iteration exists", () => {
    renderCard({ iteration: null, isRunning: true });
    expect(screen.getByTestId("trial-scorecard-loading")).toBeInTheDocument();
  });
  it("keeps each stage's recorded checks in its selected detail panel", async () => {
    const chain = {
      status: "verified",
      firstFailedStage: "selection",
      stages: [
        {
          stage: "connection",
          state: "passed",
          reason: "impliedByLaterEvidence",
        },
        { stage: "selection", state: "failed", reason: "missingToolCall" },
        {
          stage: "userValue",
          state: "notReached",
          reason: "earlierStageFailed",
        },
      ],
    } as never;
    renderCard({ chain });
    expect(
      screen.queryByRole("heading", { name: "User value chain" }),
    ).toBeNull();
    const report = screen.getByRole("region", {
      name: "User value chain — default assertions",
    });
    expect(within(report).queryByTestId("scorecard-group-state")).toBeNull();
    expect(
      within(screen.getByTestId("trial-stage-detail-card")).getAllByTestId(
        "trial-scorecard-row",
      ).length,
    ).toBeGreaterThan(0);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /01 Connection:/ }));
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveTextContent(
      "No separate connection assertion was recorded.",
    );
    expect(within(report).queryByTestId("trial-scorecard-row")).toBeNull();
  });

  it("puts default chain assertions above explicitly added assertions", () => {
    renderCard();
    const defaults = screen.getByRole("region", {
      name: "User value chain — default assertions",
    });
    const added = screen.getByRole("region", { name: "Added assertions" });
    const defaultKeys = within(defaults)
      .getAllByTestId("trial-scorecard-row")
      .map((row) => row.getAttribute("data-row-key"));
    expect(defaultKeys).toEqual(["route", "judge:goalCompletion"]);
    const addedKeys = within(added)
      .getAllByTestId("trial-scorecard-row")
      .map((row) => row.getAttribute("data-row-key"));
    const authoredKeys = buildCaseScorecard(authored)
      .groups.flatMap((group) => group.rows)
      .filter((row) => row.provenance === "step" || row.provenance === "case")
      .map((row) => row.key);
    expect(addedKeys).toEqual(authoredKeys);
    expect(
      defaults.compareDocumentPosition(added) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows an empty added-assertions section for a prompt-only case", () => {
    renderCard({
      authored: { steps: [steps[0]], toolsChoice: "unset" },
      steps: [steps[0]],
    });
    expect(
      within(
        screen.getByRole("region", { name: "Added assertions" }),
      ).getByText("No extra assertions added."),
    ).toBeInTheDocument();
  });

  it("shows the judge's recorded passing rationale without expanding a row", () => {
    renderCard({
      judgeCase: {
        status: "completed",
        passed: true,
        score: 1,
        reason:
          "The rendered diagram contains Begin, Decision, and End with connecting lines.",
      } as never,
    });
    expect(screen.getByTestId("user-value-pass-evidence")).toHaveTextContent(
      "The rendered diagram contains Begin, Decision, and End with connecting lines.",
    );
  });

  it("shows supporting stage evidence and makes missing evidence explicit", async () => {
    const chain = {
      status: "verified",
      stages: [
        {
          stage: "userValue",
          state: "passed",
          evidence: {
            predicateReasons: ["All three diagram labels were visible."],
          },
        },
      ],
    } as never;
    const { rerender } = renderCard({ chain });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /User value:/ }));
    expect(screen.getByTestId("user-value-pass-evidence")).toHaveTextContent(
      "All three diagram labels were visible.",
    );
    rerender(
      <TrialScorecard
        authored={authored}
        iteration={iteration()}
        steps={steps}
        chain={
          {
            status: "verified",
            stages: [{ stage: "userValue", state: "passed" }],
          } as never
        }
      />,
    );
    expect(screen.getByTestId("user-value-pass-evidence")).toHaveTextContent(
      "This run recorded a pass without supporting evidence.",
    );
  });

  it("does not reveal passing evidence during blind judge review", () => {
    renderCard({
      judgeHidden: true,
      judgeCase: {
        status: "completed",
        passed: true,
        score: 1,
        reason: "Private judge rationale",
      } as never,
    });
    expect(
      screen.queryByTestId("user-value-pass-evidence"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Private judge rationale"),
    ).not.toBeInTheDocument();
  });

  it("says a scorer was not measured rather than showing it as passed", () => {
    renderCard();
    expect(rowFor("No tool errors so far")).toHaveAttribute(
      "data-state",
      "notMeasured",
    );
    expect(screen.getByTestId("trial-scorecard-summary").textContent).toBe(
      "No evaluators ran",
    );
  });

  it("shows why a step failed", () => {
    const user = userEvent.setup();
    renderCard({
      iteration: iteration({
        stepResults: [
          {
            stepId: "a2",
            stepIndex: 2,
            kind: "assert",
            status: "fail",
            reason: "get_me returned isError",
          },
        ],
      }),
    });
    const row = rowFor("No tool errors so far");
    expect(row).toHaveAttribute("data-state", "failed");
    return user
      .click(within(row).getByRole("button", { name: /^Why/ }))
      .then(() => {
        expect(screen.getByTestId("trial-scorecard-reason").textContent).toBe(
          "get_me returned isError",
        );
      });
  });

  it("wears an advisory miss as a warning, and keeps it out of the gate count", () => {
    render(
      <TrialScorecard
        authored={{
          ...authored,
          predicates: {
            mode: "extend",
            list: [
              {
                type: "finalAssistantMessageNonEmpty",
                role: "advisory",
                severity: "warn",
              } as Predicate,
            ],
          },
        }}
        iteration={iteration({
          stepResults: [
            { stepId: "a2", stepIndex: 2, kind: "assert", status: "ok" },
          ],
          predicates: [
            {
              predicate: { type: "finalAssistantMessageNonEmpty" },
              passed: false,
              reason: "the answer was empty",
            },
          ],
        })}
        steps={steps}
      />,
    );
    const row = rowFor("Final message non-empty");
    expect(row).toHaveAttribute("data-state", "failed");
    expect(row).toHaveAttribute("data-role", "advisory");
    expect(within(row).getByLabelText("Missed · advisory")).toBeInTheDocument();
    const summary = screen.getByTestId("trial-scorecard-summary").textContent!;
    expect(summary).toContain("1 of 1 required passed");
    expect(summary).toContain("1 advisory");
  });

  it("never claims a verdict of its own", () => {
    // The trial header already says PASSED, from `trialVerdict`. A second word
    // here is the bug the Steps tab shipped with.
    renderCard({
      iteration: iteration({
        stepResults: [
          { stepId: "a2", stepIndex: 2, kind: "assert", status: "ok" },
        ],
      }),
    });
    const summary = screen.getByTestId("trial-scorecard-summary").textContent!;
    expect(summary).not.toMatch(/^Passed|^Failed/);
    expect(summary).toBe("1 of 1 required passed");
  });

  it("keeps the score-row view reachable but out of the way", () => {
    renderCard({ scoresSection: <div>score rows here</div> });
    const details = screen.getByTestId("iteration-score-rows");
    expect(details.tagName).toBe("DETAILS");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Score rows")).toBeInTheDocument();
  });

  it("hosts the judge's own panel as the judge row's body", () => {
    // Not a reimplementation: the panel owns the blind-label protocol, so
    // mounting it here is what keeps the protocol intact.
    renderCard({
      judgeSlot: <div data-testid="judge-panel">Judge score hidden</div>,
    });
    const judge = rowFor("Outcome achieved");
    expect(within(judge).getByTestId("judge-panel")).toBeInTheDocument();
  });

  it("never labels an unmeasured row with a pass word", () => {
    const { container } = renderCard();
    const unmeasured = screen
      .getAllByTestId("trial-scorecard-row")
      .filter((row) => row.getAttribute("data-state") === "notMeasured");
    expect(unmeasured.length).toBeGreaterThan(0);
    for (const row of unmeasured) {
      expect(within(row).getByLabelText("Not measured")).toBeInTheDocument();
    }
    expect(container.textContent).not.toMatch(/toolCalledAtLeastOnce/);
  });
});

describe("summaryLine", () => {
  const base = {
    required: { passed: 0, counted: 0 },
    advisory: 0,
    errors: 0,
    notMeasured: 0,
    pending: 0,
  };

  it("counts required rows and names the rest without promoting it", () => {
    expect(
      summaryLine({ ...base, required: { passed: 2, counted: 2 }, advisory: 1 }),
    ).toBe("2 of 2 required passed · 1 advisory");
  });

  it("says a case has no required rows rather than reporting 0 of 0", () => {
    expect(summaryLine({ ...base, advisory: 1 })).toBe(
      "No required assertions ran · 1 advisory",
    );
    expect(summaryLine(base)).toBe("No evaluators ran");
  });

  it("names an unevaluable scorer as such, not as a failure", () => {
    expect(
      summaryLine({ ...base, required: { passed: 0, counted: 1 }, errors: 1 }),
    ).toBe("0 of 1 required passed · 1 could not be evaluated");
  });

  it("never uses a pass word for a state that is not a pass", () => {
    expect(PASS_WORDS.test(summaryLine(base))).toBe(false);
    expect(PASS_WORDS.test(summaryLine({ ...base, advisory: 2 }))).toBe(false);
  });
});

describe("the chain lives inside the Scorecard", () => {
  const chain = {
    status: "verified",
    stages: [
      { stage: "connection", state: "passed" },
      { stage: "discovery", state: "passed" },
      { stage: "selection", state: "failed", reason: "missingToolCall" },
      { stage: "call", state: "notReached" },
      { stage: "response", state: "notReached" },
      { stage: "userValue", state: "notReached" },
    ],
    firstFailedStage: "selection",
  } as never;

  it("renders the shared iteration stage report above the rows", () => {
    renderCard({ chain });
    const card = screen.getByTestId("trial-scorecard");
    expect(within(card).getByTestId("trial-chain-panel")).toBeTruthy();
  });

  it("puts the verdict WORD on the group heading, not on the chip", () => {
    renderCard({ chain });
    const states = screen
      .getAllByTestId("scorecard-group-state")
      .map((el) => el.textContent);
    expect(states).toContain("failed");
    expect(
      screen.getByRole("button", { name: /03 Selection:/ }).textContent,
    ).not.toContain("failed");
  });

  it("shows no group state when the trial has no chain", () => {
    renderCard({});
    expect(screen.queryAllByTestId("scorecard-group-state")).toHaveLength(0);
    expect(screen.queryByTestId("trial-chain-panel")).toBeNull();
  });
});

describe("blind review hides the judge row's own output", () => {
  it("withholds the score and the reason", () => {
    renderCard({ judgeHidden: true });
    expect(screen.getByTestId("judge-result-withheld")).toBeTruthy();
  });

  it("shows them once the reviewer has revealed", () => {
    renderCard({ judgeHidden: false });
    expect(screen.queryByTestId("judge-result-withheld")).toBeNull();
  });

  it("hides nothing on a non-judge row", () => {
    renderCard({ judgeHidden: true });
    const withheld = screen
      .getAllByTestId("trial-scorecard-row")
      .filter((row) =>
        row.querySelector('[data-testid="judge-result-withheld"]'),
      );
    // Only the judge row withholds; a deterministic check has no verdict to
    // leak and hiding it would just make the trial unreadable.
    expect(withheld.length).toBeLessThanOrEqual(1);
  });
});

describe("blind review keeps the chain and masks one card", () => {
  const stages = (userValue: Record<string, unknown>) =>
    [
      { stage: "connection", state: "passed", reason: "observed" },
      { stage: "discovery", state: "passed", reason: "observed" },
      { stage: "selection", state: "failed", reason: "missingToolCall" },
      { stage: "call", state: "passed", reason: "observed" },
      { stage: "response", state: "passed", reason: "observed" },
      { stage: "userValue", ...userValue },
    ] as never[];
  const judgeDecided = {
    status: "verified",
    firstFailedStage: "selection",
    stages: stages({
      state: "failed",
      reason: "judgeFailed",
      evidence: { judgeReasons: ["Private judge rationale"] },
    }),
  } as never;
  const assertionDecided = {
    status: "verified",
    firstFailedStage: "selection",
    stages: stages({ state: "passed", reason: "observed" }),
  } as never;
  const judgeCase = {
    status: "completed",
    passed: false,
    score: 0.2,
    reason: "Private judge rationale",
  } as never;

  it("renders the rail, masks User value, and still withholds the judge row", () => {
    renderCard({ chain: judgeDecided, judgeHidden: true, judgeCase });
    const card = screen.getByTestId("trial-scorecard");
    expect(within(card).getByTestId("trial-chain-panel")).toBeTruthy();
    expect(within(card).getByTestId("trial-stage-masked")).toHaveAttribute(
      "data-stage",
      "userValue",
    );
    expect(
      screen.getByRole("button", { name: /06 User value/ }),
    ).toHaveAccessibleName(/hidden until you label/);
    expect(screen.getByTestId("judge-result-withheld")).toBeTruthy();
    expect(screen.queryByText("Private judge rationale")).toBeNull();
    expect(screen.queryByTestId("user-value-pass-evidence")).toBeNull();
    // The other five stages are the runner's, and stay readable.
    expect(
      screen.getByRole("button", { name: /03 Selection/ }),
    ).not.toHaveAccessibleName(/hidden until/);
  });

  it("does not put the masked stage's state on its group heading", () => {
    renderCard({ chain: judgeDecided, judgeHidden: true, judgeCase });
    const userValue = document.querySelector('[data-stage-group="userValue"]');
    expect(userValue).not.toBeNull();
    expect(
      userValue!.querySelector('[data-testid="scorecard-group-state"]'),
    ).toBeNull();
    // Selection's own failure is the runner's, and stays on its heading.
    const selection = document.querySelector('[data-stage-group="selection"]');
    expect(
      selection?.querySelector('[data-testid="scorecard-group-state"]')
        ?.textContent,
    ).toBe("failed");
  });

  it("masks nothing when an assertion decided User value", () => {
    renderCard({ chain: assertionDecided, judgeHidden: true, judgeCase });
    expect(screen.getByTestId("trial-chain-panel")).toBeTruthy();
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
    expect(
      screen.getByRole("button", { name: /06 User value/ }),
    ).not.toHaveAccessibleName(/hidden until/);
    // User value is still the open card, so the judge row is on screen and
    // its own output is still withheld: the row is the judge's even when the
    // chain was not.
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "userValue",
    );
    expect(screen.getByTestId("judge-result-withheld")).toBeTruthy();
  });

  it("drops the mask once the reviewer has revealed", () => {
    renderCard({ chain: judgeDecided, judgeHidden: false, judgeCase });
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
    expect(screen.queryByTestId("judge-result-withheld")).toBeNull();
  });
});

describe("what the scorecard says about its AI explanations", () => {
  const verifiedChain = {
    status: "verified",
    stages: [
      { stage: "connection", state: "passed", reason: "observed" },
      { stage: "discovery", state: "passed", reason: "observed" },
      { stage: "selection", state: "passed", reason: "observed" },
      { stage: "call", state: "passed", reason: "observed" },
      { stage: "response", state: "failed", reason: "toolError" },
      { stage: "userValue", state: "failed", reason: "predicateFailed" },
    ],
  } as never;

  const toolErrorTrace = {
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "create_journey",
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "VALIDATION_ERROR: A journey must target at least one host",
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it("offers Analyze on a settled iteration with no report", () => {
    renderCard({ chain: verifiedChain });
    expect(screen.getByTestId("report-availability")).toHaveTextContent(
      "Analyze this run to add AI explanations to these rows.",
    );
  });

  it("counts the read in progress instead of promising nothing", () => {
    renderCard({
      chain: verifiedChain,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "pending",
        progress: { done: 4, total: 40 },
        rows: [],
      } as never,
    });
    const line = screen.getByTestId("report-availability");
    expect(line).toHaveTextContent("Reading iterations 4 of 40…");
    expect(line).toHaveAttribute("aria-live", "polite");
  });

  it("names what stopped the analysis, and keeps the recorded page", () => {
    renderCard({
      chain: verifiedChain,
      trace: toolErrorTrace,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "failed",
        reason: "trace_too_large",
        rows: [],
      } as never,
    });
    expect(screen.getByTestId("report-availability")).toHaveTextContent(
      "This iteration's trace was too large to analyze.",
    );
    // The deterministic floor does not depend on the model having run.
    // The tool name renders as code, so assert on the words, not the marks.
    const floor = screen.getByTestId("stage-floor");
    expect(within(floor).getByText("create_journey").tagName).toBe("CODE");
    expect(floor).toHaveTextContent(
      "returned an error: VALIDATION_ERROR: A journey must target at least one host",
    );
  });

  it("quotes the server on a failed stage with no report at all", () => {
    renderCard({ chain: verifiedChain, trace: toolErrorTrace });
    expect(screen.getByTestId("stage-floor")).toHaveAttribute(
      "data-narrative-source",
      "recorded",
    );
  });

  it("yields the stage to an AI explanation rather than saying it twice", () => {
    renderCard({
      chain: verifiedChain,
      trace: toolErrorTrace,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "ready",
        rows: [],
        stageNotes: [
          {
            stage: "response",
            actual: "The journey call was rejected for having no host.",
            citations: ["tc:call-1"],
          },
        ],
      } as never,
    });
    expect(screen.queryByTestId("stage-floor")).toBeNull();
    expect(screen.queryByTestId("report-availability")).toBeNull();
    expect(
      screen.getByText("The journey call was rejected for having no host."),
    ).toBeVisible();
  });

  it("promises a reviewer nothing while they are labelling blind", () => {
    renderCard({
      chain: verifiedChain,
      trace: toolErrorTrace,
      judgeHidden: true,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "pending",
        progress: { done: 1, total: 4 },
        rows: [],
      } as never,
    });
    expect(screen.queryByTestId("report-availability")).toBeNull();
    expect(screen.queryByTestId("stage-floor")).toBeNull();
  });
});
