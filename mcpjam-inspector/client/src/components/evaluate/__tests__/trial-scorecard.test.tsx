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
    expect(row).toHaveAttribute("data-role", "warn");
    expect(within(row).getByLabelText("Missed · warning")).toBeInTheDocument();
    const summary = screen.getByTestId("trial-scorecard-summary").textContent!;
    expect(summary).toContain("1 of 1 gate passed");
    expect(summary).toContain("1 warn");
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
    expect(summary).toBe("1 of 1 gate passed");
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
    const judge = rowFor("Judge · Goal completion");
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
    gates: { passed: 0, counted: 0 },
    warn: 0,
    report: 0,
    errors: 0,
    notMeasured: 0,
    pending: 0,
  };

  it("counts gates and names the rest without promoting it", () => {
    expect(
      summaryLine({ ...base, gates: { passed: 2, counted: 2 }, warn: 1 }),
    ).toBe("2 of 2 gates passed · 1 warn");
  });

  it("says a case has no gates rather than reporting 0 of 0", () => {
    expect(summaryLine({ ...base, warn: 1 })).toBe("No gates ran · 1 warn");
    expect(summaryLine(base)).toBe("No evaluators ran");
  });

  it("names an unevaluable scorer as such, not as a failure", () => {
    expect(
      summaryLine({ ...base, gates: { passed: 0, counted: 1 }, errors: 1 }),
    ).toBe("0 of 1 gate passed · 1 could not be evaluated");
  });

  it("never uses a pass word for a state that is not a pass", () => {
    expect(PASS_WORDS.test(summaryLine(base))).toBe(false);
    expect(PASS_WORDS.test(summaryLine({ ...base, warn: 2 }))).toBe(false);
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
