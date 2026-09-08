import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestedFromRunCard } from "../case-scorecard/suggested-from-run-card";
import type { Suggestion } from "../case-scorecard/suggest-from-run";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

const suggestion = (over: Partial<Suggestion> = {}): Suggestion =>
  ({
    key: over.key ?? "k1",
    kind: "predicate",
    basis: "held",
    purpose: "Catch tool failures",
    label: "No tool errors",
    consequence:
      "Future runs where a tool returns an error will fail this case.",
    evidence: "No tool errored in 3 of 3 trials (7 calls)",
    predicate: { type: "noToolErrors" },
    placement: { kind: "wholeRun" },
    role: "gate",
    stability: { held: 3, of: 3, unread: 0 },
    stage: "userValue",
    ...over,
  }) as Suggestion;

const noRead = { pending: 0, failed: 0, capped: 0, total: 3 };

const renderCard = (
  over: Partial<Parameters<typeof SuggestedFromRunCard>[0]> = {},
) => {
  const onAccept = vi.fn();
  const onAcceptAll = vi.fn();
  const onDismiss = vi.fn();
  render(
    <SuggestedFromRunCard
      suggestions={[suggestion()]}
      diagnosis={null}
      of={3}
      read={noRead}
      accepted={new Set()}
      onAccept={onAccept}
      onAcceptAll={onAcceptAll}
      onDismiss={onDismiss}
      {...over}
    />,
  );
  return { onAccept, onAcceptAll, onDismiss };
};

describe("a row leads with what it protects", () => {
  it("shows the purpose first and the mechanism underneath", () => {
    renderCard();
    const row = screen.getByTestId("suggestion-row");
    expect(within(row).getByText("Catch tool failures")).toBeTruthy();
    expect(within(row).getByText("No tool errors")).toBeTruthy();
  });

  it("states the consequence of accepting a requirement", () => {
    renderCard();
    expect(
      screen.getByText(
        "Future runs where a tool returns an error will fail this case.",
      ),
    ).toBeTruthy();
  });

  it("shows the evidence and how many trials it held in", () => {
    renderCard();
    expect(screen.getByText(/No tool errored in 3 of 3/)).toBeTruthy();
    expect(screen.getByText("held in 3 of 3 trials")).toBeTruthy();
  });

  it("warns when a single trial is all the evidence there is", () => {
    renderCard({ of: 1, suggestions: [suggestion()] });
    expect(screen.getByText("1 of 1 — run more to be sure")).toBeTruthy();
  });
});

describe("accepting", () => {
  it("adds one row", async () => {
    const { onAccept } = renderCard();
    await userEvent.setup().click(screen.getByRole("button", { name: "Add" }));
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k1" }),
    );
  });

  it("confirms before Add all when requirements are involved", async () => {
    const user = userEvent.setup();
    const { onAcceptAll } = renderCard({
      suggestions: [suggestion(), suggestion({ key: "k2" })],
    });
    await user.click(screen.getByRole("button", { name: "Add all 2" }));
    // Requirements change whether future runs fail; that is not a surprise to
    // spring after the click.
    expect(screen.getByTestId("suggestion-add-all-confirm")).toBeTruthy();
    expect(screen.getByText(/2 requirements and 0 reports/)).toBeTruthy();
    expect(onAcceptAll).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add all" }));
    expect(onAcceptAll).toHaveBeenCalled();
  });

  it("does not confirm when everything is a report", async () => {
    const { onAcceptAll } = renderCard({
      suggestions: [
        suggestion({ role: "report", consequence: undefined }),
        suggestion({ key: "k2", role: "report", consequence: undefined }),
      ],
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Add all 2" }));
    expect(onAcceptAll).toHaveBeenCalled();
  });

  it("says the accepted check is not applied to this run", () => {
    renderCard({ accepted: new Set(["k1"]) });
    expect(
      screen.getByText(
        "Added — run again to grade it; this run is not re-graded.",
      ),
    ).toBeTruthy();
  });
});

describe("dismissing", () => {
  it("reports the dismissal", async () => {
    const { onDismiss } = renderCard();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("grouping", () => {
  it("heads a positioned row with the step it lands under", () => {
    renderCard({
      suggestions: [
        suggestion({
          key: "p1",
          placement: {
            kind: "afterStep",
            anchorStepId: "s1",
            actionOrdinal: 2,
            turnIndex: 1,
          },
        }),
      ],
    });
    expect(screen.getByText("After step 2")).toBeTruthy();
  });

  it("heads whole-run rows separately", () => {
    renderCard();
    expect(screen.getByText("After the run")).toBeTruthy();
  });

  it("folds a long list behind Show more", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      suggestion({ key: `k${i}` }),
    );
    renderCard({ suggestions: many });
    expect(screen.getAllByTestId("suggestion-row")).toHaveLength(6);
    await userEvent.setup().click(screen.getByText("Show 3 more"));
    expect(screen.getAllByTestId("suggestion-row")).toHaveLength(9);
  });
});

describe("a batch that did not succeed", () => {
  it("leads with the failure and offers no requirement", () => {
    renderCard({
      suggestions: [suggestion({ role: "report", consequence: undefined })],
      diagnosis: { unsuccessful: 2, of: 3, noSignal: false },
    });
    expect(
      screen.getByText(/2 of 3 trials did not accomplish the goal/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Requirements are suggested once every trial accomplishes the goal.",
      ),
    ).toBeTruthy();
  });

  it("explains an unjudged batch differently from a failed one", () => {
    renderCard({
      suggestions: [],
      diagnosis: { unsuccessful: 1, of: 1, noSignal: true },
    });
    expect(
      screen.getByText(/Nothing confirmed that this run accomplished the goal/),
    ).toBeTruthy();
    expect(screen.getByText(/Run test with a goal sentence/)).toBeTruthy();
  });

  it("links to where it failed when there is a failure to see", async () => {
    const onSeeFailure = vi.fn();
    render(
      <SuggestedFromRunCard
        suggestions={[]}
        diagnosis={{ unsuccessful: 1, of: 3, noSignal: false }}
        of={3}
        read={noRead}
        accepted={new Set()}
        onAccept={vi.fn()}
        onAcceptAll={vi.fn()}
        onDismiss={vi.fn()}
        onSeeFailure={onSeeFailure}
      />,
    );
    await userEvent.setup().click(screen.getByText("See where it failed"));
    expect(onSeeFailure).toHaveBeenCalled();
  });
});

describe("read state", () => {
  it("says traces are still loading", () => {
    renderCard({ read: { ...noRead, pending: 3 } });
    expect(screen.getByText("Reading 3 trial traces…")).toBeTruthy();
  });

  it("says which checks a failed read cost", () => {
    renderCard({ read: { ...noRead, failed: 1 } });
    expect(
      screen.getByText(
        /1 trace could not be read, so wording and error checks/,
      ),
    ).toBeTruthy();
  });

  it("says when the batch was larger than the read cap", () => {
    renderCard({ read: { pending: 0, failed: 0, capped: 3, total: 8 } });
    expect(
      screen.getByText(/This batch has 8 trials; traces are read for 5/),
    ).toBeTruthy();
  });
});

describe("always", () => {
  it("says Response is not gradable in this release", () => {
    renderCard();
    expect(screen.getByText(/Nothing checks Response yet/)).toBeTruthy();
  });

  it("says so when nothing was stable", () => {
    renderCard({ suggestions: [] });
    expect(
      screen.getByText("Nothing else was stable across every trial."),
    ).toBeTruthy();
  });
});
