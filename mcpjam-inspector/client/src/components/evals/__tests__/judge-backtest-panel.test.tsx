/**
 * Backtesting a rubric edit before it is saved.
 *
 * The two properties worth a test are both about NOT DOING THINGS. The action
 * spends credits, so it must never fire on mount — a review dialog that
 * silently bills every time somebody opens it is worse than no backtest. And a
 * billing refusal is INFORMATION rather than an exception: throwing it would
 * take the review dialog down over an optional check.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("convex/react", () => ({
  useAction: () => mocks.action,
}));

import {
  describeIncomparable,
  JudgeBacktestPanel,
} from "../judge-backtest-panel";

function renderPanel() {
  return render(
    <JudgeBacktestPanel
      suiteId="suite-1"
      runId="run-1"
      runNumber={4}
      draftRubric={{ criteria: [{ id: "cites", label: "Cites a source" }] }}
    />,
  );
}

describe("JudgeBacktestPanel", () => {
  it("never calls the action on mount", () => {
    mocks.action.mockClear();
    renderPanel();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Backtest against run #4/ }),
    ).toBeTruthy();
  });

  it("sends the DRAFT criteria, and null when the draft clears them", async () => {
    const user = userEvent.setup();
    mocks.action.mockClear();
    mocks.action.mockResolvedValue({ ok: false, reason: "no credits" });
    const { rerender } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Backtest/ }));
    expect(mocks.action).toHaveBeenLastCalledWith({
      suiteId: "suite-1",
      runId: "run-1",
      judgeRubricDraft: [{ id: "cites", label: "Cites a source" }],
    });

    rerender(
      <JudgeBacktestPanel
        suiteId="suite-1"
        runId="run-1"
        runNumber={4}
        draftRubric={undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Backtest/ }));
    // `null`, not `[]`: the backend reads an empty list as a rubric that asks
    // nothing and null as no rubric at all.
    expect(mocks.action).toHaveBeenLastCalledWith(
      expect.objectContaining({ judgeRubricDraft: null }),
    );
  });

  it("renders a billing refusal as a notice", async () => {
    const user = userEvent.setup();
    mocks.action.mockResolvedValue({
      ok: false,
      reason: "Your plan does not include judge backtests.",
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Backtest/ }));
    expect(
      await screen.findByText("Your plan does not include judge backtests."),
    ).toBeTruthy();
  });

  it("shows no flip count when the run is not comparable", async () => {
    const user = userEvent.setup();
    mocks.action.mockResolvedValue({
      ok: true,
      comparable: false,
      reason: "no_stored_verdict",
      draftSuiteRubricHash: "h",
      storedSuiteRubricHash: null,
      cases: [
        {
          gradingKey: "case_a#1",
          iterationId: null,
          stored: null,
          draft: { score: 0.9, band: "pass" },
          flipped: false,
        },
      ],
      summary: { graded: 1, flips: 0, storedMissing: 1 },
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Backtest/ }));
    expect(
      await screen.findByText("Not comparable: this run was never judged"),
    ).toBeTruthy();
    expect(screen.queryByText(/verdicts would change/)).toBeNull();
    // The draft's own bands still render: "here is what the new rubric says"
    // is useful even when "here is what changed" is unavailable.
    expect(screen.getByText("case_a#1")).toBeTruthy();
  });

  it("counts and highlights the flips when it is comparable", async () => {
    const user = userEvent.setup();
    mocks.action.mockResolvedValue({
      ok: true,
      comparable: true,
      draftSuiteRubricHash: "h2",
      storedSuiteRubricHash: "h1",
      cases: [
        {
          gradingKey: "case_a#1",
          iterationId: "it_1",
          stored: { score: 0.9, band: "pass" },
          draft: { score: 0.4, band: "fail" },
          flipped: true,
        },
        {
          gradingKey: "case_b#1",
          iterationId: "it_2",
          stored: { score: 0.9, band: "pass" },
          draft: { score: 0.88, band: "pass" },
          flipped: false,
        },
      ],
      summary: { graded: 2, flips: 1, storedMissing: 0 },
    });
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Backtest/ }));
    expect(
      await screen.findByText("1 of 2 verdicts would change"),
    ).toBeTruthy();
    const flipped = container.querySelectorAll('[data-flipped="true"]');
    expect(flipped).toHaveLength(1);
    expect(flipped[0].getAttribute("data-backtest-case")).toBe("case_a#1");
  });

  it("translates the cooldown into advice", async () => {
    const user = userEvent.setup();
    mocks.action.mockRejectedValue(
      new Error("[CONVEX] EVAL_JUDGE_BACKTEST_COOLDOWN"),
    );
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Backtest/ }));
    expect(
      await screen.findByText("Wait a minute before running another backtest."),
    ).toBeTruthy();
  });
});

describe("describeIncomparable", () => {
  it("maps the reason keys, and passes an unknown one through", () => {
    expect(describeIncomparable("no_stored_verdict")).toBe(
      "Not comparable: this run was never judged",
    );
    expect(describeIncomparable("template_version_differs")).toBe(
      "Not comparable: this run was judged by an older judge version",
    );
    expect(describeIncomparable("something_new")).toBe(
      "Not comparable: something_new",
    );
    expect(describeIncomparable(undefined)).toBe("Not comparable");
  });
});
