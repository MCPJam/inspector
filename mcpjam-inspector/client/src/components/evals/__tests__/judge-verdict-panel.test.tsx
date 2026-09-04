/**
 * The blind protocol, and what a label is allowed to change.
 *
 * A calibration label is EVIDENCE ABOUT THE JUDGE, never a verdict about the
 * run. The backend counts only blind labels toward the agreement rate — a
 * label chosen while looking at the judge's answer measures anchoring, not
 * judgement — and this panel is what asserts `blind`. A wrong assertion here
 * inflates a calibration that decides whether a judge may fail other people's
 * builds, so the two paths are pinned separately.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  JudgeVerdictPanel,
  type TrialJudgeReview,
} from "../goal-completion-presentation";
import type { JudgeCase } from "../goal-completion-presentation";

const JUDGE_CASE: JudgeCase = {
  caseKey: "case_a",
  gradingKey: "case_a#1",
  iterationId: "it_1",
  score: 0.42,
  passed: false,
  reason: "The answer never named the file.",
  rubricHits: [],
};

function renderPanel(
  overrides: {
    review?: TrialJudgeReview | null;
    onReview?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onReview = overrides.onReview ?? vi.fn();
  const result = render(
    <JudgeVerdictPanel
      judgeCase={JUDGE_CASE}
      review={overrides.review ?? null}
      onReview={onReview}
    />,
  );
  return { ...result, onReview };
}

describe("JudgeVerdictPanel calibration", () => {
  it("hides the judge's verdict until it is asked for", () => {
    renderPanel();
    expect(screen.getByTestId("trial-review-control")).toBeTruthy();
    // The band is what a reviewer must not see first — its presence is what
    // turns a judgement into an agreement.
    expect(screen.queryByText(/The answer never named the file/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reveal judge verdict" }),
    ).toBeTruthy();
  });

  it("labels before revealing as BLIND", async () => {
    const user = userEvent.setup();
    const { onReview } = renderPanel();
    await user.click(screen.getByRole("button", { name: "fail" }));
    expect(onReview).toHaveBeenCalledWith("fail", { blind: true });
  });

  it("labels after revealing as NOT blind, and says so", async () => {
    const user = userEvent.setup();
    const { onReview } = renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Reveal judge verdict" }),
    );
    expect(screen.getByTestId("trial-review-not-blind").textContent).toContain(
      "won't count toward calibration",
    );
    await user.click(screen.getByRole("button", { name: "pass" }));
    expect(onReview).toHaveBeenCalledWith("pass", { blind: false });
  });

  it("carries an optional note with the label", async () => {
    const user = userEvent.setup();
    const { onReview } = renderPanel();
    await user.type(screen.getByLabelText("Reviewer note"), "cited nothing");
    await user.click(screen.getByRole("button", { name: "partial" }));
    expect(onReview).toHaveBeenCalledWith("partial", {
      blind: true,
      note: "cited nothing",
    });
  });

  it("shows both readings once a label exists", () => {
    renderPanel({
      review: {
        reviewerVerdict: "fail",
        judgeVerdict: "partial",
        note: "cited nothing",
        blind: true,
        createdAt: 1,
      },
    });
    const provenance = screen.getByTestId("trial-review-provenance");
    // BOTH, side by side: the point of a label is the comparison, and showing
    // only the reviewer's would hide what it is evidence about.
    expect(provenance.textContent).toContain("Judge: partial");
    expect(provenance.textContent).toContain("Reviewer: fail");
    expect(provenance.textContent).toContain("cited nothing");
    // Revealed, because a labelled trial has nothing left to hide.
    expect(screen.getByText(/The answer never named the file/)).toBeTruthy();
  });

  it("re-labelling can never be blind", async () => {
    const user = userEvent.setup();
    const { onReview } = renderPanel({
      review: {
        reviewerVerdict: "fail",
        judgeVerdict: "partial",
        note: null,
        blind: true,
        createdAt: 1,
      },
    });
    await user.click(screen.getByRole("button", { name: "Change label" }));
    await user.click(screen.getByRole("button", { name: "pass" }));
    // The judge's verdict has been on screen the whole time.
    expect(onReview).toHaveBeenCalledWith("pass", { blind: false });
  });

  it("renders the plain card when labelling is not offered", () => {
    render(<JudgeVerdictPanel judgeCase={JUDGE_CASE} />);
    expect(screen.queryByTestId("trial-review-control")).toBeNull();
    // Nothing is hidden from a reader who cannot label: the blind protocol
    // exists to protect the calibration, not to withhold the verdict.
    expect(screen.getByText(/The answer never named the file/)).toBeTruthy();
  });
});
