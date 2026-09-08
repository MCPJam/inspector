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
  it("shows the same rows the left pane authored, in the same order", () => {
    // The whole point: what you asked for and what happened line up row for
    // row, so a reader never has to map one list onto another.
    renderCard();
    const authoredKeys = buildCaseScorecard(authored)
      .groups.flatMap((group) => group.rows)
      .map((row) => row.key);
    const shownKeys = screen
      .getAllByTestId("trial-scorecard-row")
      .map((row) => row.getAttribute("data-row-key"));
    expect(shownKeys).toEqual(authoredKeys);
  });

  it("says a scorer was not measured rather than showing it as passed", () => {
    renderCard();
    expect(rowFor("No tool errors so far")).toHaveAttribute(
      "data-state",
      "notMeasured",
    );
    expect(screen.getByTestId("trial-scorecard-summary").textContent).toBe(
      "No scorers ran",
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
      expect(
        within(row).getByLabelText("Not measured"),
      ).toBeInTheDocument();
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
    expect(summaryLine(base)).toBe("No scorers ran");
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

  it("renders the strip above the rows", () => {
    renderCard({ chain });
    const card = screen.getByTestId("trial-scorecard");
    expect(within(card).getByTestId("stage-strip")).toBeTruthy();
  });

  it("puts the verdict WORD on the group heading, not on the chip", () => {
    renderCard({ chain });
    const states = screen
      .getAllByTestId("scorecard-group-state")
      .map((el) => el.textContent);
    expect(states).toContain("failed");
    expect(
      screen.getByTestId("stage-chip-selection").textContent,
    ).not.toContain("failed");
  });

  it("shows no group state when the trial has no chain", () => {
    renderCard({});
    expect(screen.queryAllByTestId("scorecard-group-state")).toHaveLength(0);
    expect(screen.queryByTestId("stage-strip")).toBeNull();
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
