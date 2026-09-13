import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { CaseScorecard } from "../case-scorecard/case-scorecard";
import type { CaseScorecardInput } from "../case-scorecard/case-scorecard-model";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

const steps: TestStep[] = [
  { id: "s1", kind: "prompt", prompt: "Who am I signed in as?" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "firstToolWas", toolName: "get_me" },
  },
  { id: "a2", kind: "assert", assertion: { type: "noToolErrors" } },
];

const baseInput: CaseScorecardInput = {
  steps,
  toolsChoice: "unset",
  predicates: {
    mode: "extend",
    list: [{ type: "finalAssistantMessageNonEmpty" } as Predicate],
  },
  suiteDefaultPredicates: [
    { type: "tokenBudgetUnder", tokens: 4000 } as Predicate,
  ],
  suiteJudgeConfig: {
    goalCompletion: { judgeModel: "anthropic/x", threshold: 0.7 },
  },
};

function renderCard(
  overrides: Partial<Parameters<typeof CaseScorecard>[0]> = {},
) {
  const handlers = {
    onStepPredicateChange: vi.fn(),
    onRemoveStep: vi.fn(),
    onCasePredicateChange: vi.fn(),
    onRemoveCasePredicate: vi.fn(),
    onAddScorer: vi.fn(),
    onExpectedOutputChange: vi.fn(),
    onJudgeSkippedChange: vi.fn(),
    onOpenSuiteSettings: vi.fn(),
    onSetTools: vi.fn(),
    onChooseNoTool: vi.fn(),
    onChooseTools: vi.fn(),
    onAddTool: vi.fn(),
    onSetKind: vi.fn(),
  };
  const result = render(
    <CaseScorecard input={baseInput} {...handlers} {...overrides} />,
  );
  return { ...handlers, ...result };
}

const rows = () => screen.getAllByTestId("case-scorecard-row");
const rowFor = (label: string) =>
  rows().find((row) => row.textContent?.includes(label))!;

describe("CaseScorecard", () => {
  it("groups scorers by the link of the chain they measure", () => {
    const { container } = renderCard();
    const groups = Array.from(
      container.querySelectorAll("[data-stage-group]"),
    ).map((node) => node.getAttribute("data-stage-group"));
    // Response sits between them under analyzer 11: `noToolErrors` grades the
    // answer coming back, not whether the person got what they asked for.
    expect(groups).toEqual(["selection", "response", "userValue"]);
    expect(screen.getByText("Selection")).toBeInTheDocument();
    expect(
      screen.getByText("Did the model choose the right tool for the request?"),
    ).toBeInTheDocument();
  });

  it("says who wrote each scorer", () => {
    renderCard();
    expect(rowFor("First tool called was… get_me")).toHaveAttribute(
      "data-provenance",
      "step",
    );
    expect(rowFor("Final message non-empty")).toHaveAttribute(
      "data-provenance",
      "case",
    );
    expect(rowFor("Token budget under 4000")).toHaveAttribute(
      "data-provenance",
      "suite",
    );
  });

  it("never shows a wire enum", () => {
    const { container } = renderCard();
    expect(container.textContent).not.toMatch(
      /toolCalledAtLeastOnce|firstToolWas|responseContains|noToolErrors|finalAssistantMessageNonEmpty/,
    );
  });

  it("sends an inherited scorer to the suite instead of editing it here", () => {
    const { onOpenSuiteSettings } = renderCard();
    const suite = rowFor("Token budget under 4000");
    expect(
      within(suite).queryByRole("button", { name: /^Remove/ }),
    ).not.toBeInTheDocument();
    within(suite)
      .getByRole("button", { name: "Edit in suite settings" })
      .click();
    expect(onOpenSuiteSettings).toHaveBeenCalled();
  });
});

describe("CaseScorecard — the left rail", () => {
  it("numbers a step by its own position, the way the Steps pane does", () => {
    renderCard();
    const markers = screen
      .getAllByTestId("scorecard-row-marker")
      .map((m) => m.getAttribute("data-step-number"));
    // steps: [prompt, firstToolWas, noToolErrors] → the checks are 2 and 3.
    expect(markers.filter(Boolean)).toEqual(["2", "3"]);
  });

  it("refuses to number a check that runs at no particular moment", () => {
    // Case and suite checks are graded once, together, over the finished
    // transcript. A number would claim a sequence that was never run.
    renderCard();
    for (const provenance of ["case", "suite", "route", "judge"]) {
      const row =
        provenance === "judge"
          ? screen.getByTestId("case-judge-block")
          : provenance === "route"
            ? screen.getByTestId("case-route-row")
            : rows().find(
                (r) => r.getAttribute("data-provenance") === provenance,
              )!;
      const marker = within(row).getAllByTestId("scorecard-row-marker")[0];
      expect(marker).not.toHaveAttribute("data-step-number");
    }
  });

  it("says when each kind of scorer runs", () => {
    renderCard();
    const step = rowFor("No tool errors so far");
    expect(
      within(step).getAllByTestId("scorecard-row-marker")[0],
    ).toHaveAttribute("title", "Step 3 — graded when the run reaches it");
    const suite = rowFor("Token budget under 4000");
    expect(
      within(suite).getAllByTestId("scorecard-row-marker")[0],
    ).toHaveAttribute("title", "Graded once, over the finished transcript");
    expect(
      within(screen.getByTestId("case-judge-block")).getAllByTestId(
        "scorecard-row-marker",
      )[0],
    ).toHaveAttribute("title", "Runs last, after every assertion");
  });
});

describe("CaseScorecard — roles", () => {
  const withPolicy = {
    scorers: { checkPolicy: true },
  } as unknown as SuiteCapabilities;

  it("offers Gate / Warn / Report only when the backend accepts a role", () => {
    renderCard({ checkPolicy: false });
    expect(
      screen.queryByRole("group", { name: /^Role for/ }),
    ).not.toBeInTheDocument();

    renderCard({ checkPolicy: true });
    expect(
      screen.getAllByRole("group", { name: /^Role for/ }).length,
    ).toBeGreaterThan(0);
  });

  it("still reports an advisory check honestly when it cannot be edited", () => {
    // Not being able to EDIT a role is not a reason to misreport it: a suite
    // file can author `role: "advisory"` on any backend.
    renderCard({
      checkPolicy: false,
      input: {
        ...baseInput,
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
      },
    });
    expect(rowFor("Final message non-empty")).toHaveAttribute(
      "data-role",
      "warn",
    );
    expect(
      within(rowFor("Final message non-empty")).getByText("Warn"),
    ).toBeInTheDocument();
  });

  it("writes a step's role into the step, never into the case predicates", async () => {
    const user = userEvent.setup();
    const { onStepPredicateChange, onCasePredicateChange } = renderCard({
      checkPolicy: true,
    });
    const row = rowFor("No tool errors so far");
    await user.click(within(row).getByRole("button", { name: "Warn" }));
    expect(onStepPredicateChange).toHaveBeenCalledWith("a2", {
      type: "noToolErrors",
      role: "advisory",
      severity: "warn",
    });
    expect(onCasePredicateChange).not.toHaveBeenCalled();
  });

  it("withholds Gate from an observation, the way the suite table does", () => {
    // An observation is a heuristic, and the Zod schema REFUSES a gating one
    // on save. Offering the segment here made the case page — the surface with
    // the most authoring traffic — a control that lies: click Gate, get a
    // rejected write with no explanation.
    renderCard({
      checkPolicy: true,
      input: {
        ...baseInput,
        predicates: {
          mode: "extend",
          list: [
            {
              type: "noEndingQuestion",
              role: "advisory",
              severity: "warn",
            } as Predicate,
          ],
        },
      },
    });
    const row = rowFor("Final message does not end with a question");
    const group = within(row).getByRole("group", { name: /^Role for/ });
    expect(within(group).queryByRole("button", { name: "Gate" })).toBeNull();
    expect(
      within(group).getByRole("button", { name: "Warn" }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: "Report" }),
    ).toBeInTheDocument();
  });

  it("does not offer a role on the route, because an advisory route is not a route", () => {
    renderCard({ checkPolicy: true });
    const route = screen.getByTestId("case-route-row");
    expect(
      within(route).queryByRole("group", { name: /Role/ }),
    ).not.toBeInTheDocument();
    expect(within(route).getByText("Gate")).toBeInTheDocument();
  });
});

describe("CaseScorecard — the library", () => {
  it("adds one case-level scorer, open, from a single menu", async () => {
    const user = userEvent.setup();
    const { onAddScorer } = renderCard();
    await user.click(screen.getByRole("button", { name: "Add assertion" }));
    await user.click(screen.getByTestId("add-step-item-check:noToolErrors"));
    expect(onAddScorer).toHaveBeenCalledWith({ type: "noToolErrors" });
  });

  it("does not offer the kind the route question owns", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Add assertion" }));
    expect(
      screen.queryByTestId("add-step-item-check:toolCalledWith"),
    ).toBeNull();
  });
});

describe("CaseScorecard — the judge", () => {
  it("says what the judge will grade against, and what it will use", () => {
    renderCard();
    expect(screen.getByTestId("case-judge-rubric-hint")).toHaveAttribute(
      "data-rubric-source",
      "objective",
    );
    expect(screen.getByTestId("case-judge-facts").textContent).toContain(
      "anthropic/x",
    );
    expect(screen.getByTestId("case-judge-facts").textContent).toContain(
      "threshold 0.7",
    );
  });

  it("changes its answer as the case gains a goal sentence", () => {
    renderCard({
      input: { ...baseInput, expectedOutput: "states the email address" },
    });
    expect(screen.getByTestId("case-judge-rubric-hint")).toHaveAttribute(
      "data-rubric-source",
      "expected_output",
    );
  });

  it("writes the per-case opt-out", async () => {
    const user = userEvent.setup();
    const { onJudgeSkippedChange } = renderCard();
    await user.click(
      screen.getByRole("switch", { name: "Skip the judge for this case" }),
    );
    expect(onJudgeSkippedChange).toHaveBeenCalledWith(true);
  });

  it("does not offer to skip a judge the suite already turned off", () => {
    // A control with no effect, on a page whose whole job is saying what will
    // happen.
    renderCard({
      input: {
        ...baseInput,
        suiteJudgeConfig: { goalCompletion: { enabled: false } },
      },
    });
    expect(
      screen.queryByRole("switch", { name: "Skip the judge for this case" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("case-judge-facts").textContent).toContain(
      "Judge is off for this suite.",
    );
  });
});

describe("CaseScorecard — read-only", () => {
  it("offers nothing to edit on a frozen trial", () => {
    renderCard({
      readOnly: true,
      input: {
        ...baseInput,
        snapshotPredicates: [{ type: "noToolErrors" } as Predicate],
      },
    });
    expect(
      screen.queryByRole("button", { name: "Add assertion" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Skip the judge for this case" }),
    ).not.toBeInTheDocument();
    expect(
      rows().some((row) => row.getAttribute("data-provenance") === "snapshot"),
    ).toBe(true);
  });

  it("says when a case is not running its suite's scorers", () => {
    renderCard({
      input: {
        ...baseInput,
        predicates: {
          mode: "replace",
          list: [{ type: "noToolErrors" } as Predicate],
        },
      },
    });
    expect(screen.getByTestId("case-scorecard-replaced").textContent).toContain(
      "1 is not applied",
    );
    expect(
      rows().some((row) => row.getAttribute("data-provenance") === "suite"),
    ).toBe(false);
  });
});
