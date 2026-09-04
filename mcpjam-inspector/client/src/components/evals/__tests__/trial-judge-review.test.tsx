/**
 * The label read is scoped to the trial it was issued for.
 *
 * A calibration label is attributed to whichever trial the panel was showing
 * when it was chosen, and "no label yet" is what unlocks the blind control. So
 * two things must never happen: one trial's label rendered under another
 * trial's verdict, and the blind control offered before the read for THIS
 * trial has landed — a label submitted then is a fresh `blind: true` row that
 * supersedes one the reviewer never saw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrialJudgeReviewPanel } from "../trial-judge-review";
import type {
  JudgeCase,
  TrialJudgeReview,
} from "../goal-completion-presentation";

const { mockQuery, mockSubmit } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSubmit: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: mockQuery }),
  useMutation: () => mockSubmit,
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const JUDGE_CASE: JudgeCase = {
  caseKey: "case_a",
  gradingKey: "case_a#1",
  iterationId: "it_1",
  score: 0.42,
  passed: false,
  reason: "The answer never named the file.",
  rubricHits: [],
};

function review(reviewerVerdict: TrialJudgeReview["reviewerVerdict"]) {
  return {
    reviewerVerdict,
    judgeVerdict: "partial",
    note: null,
    blind: true,
    createdAt: 1,
  } satisfies TrialJudgeReview;
}

/** One read per trial, each settled by the test and not before. */
function deferredReads() {
  const pending = new Map<string, (row: TrialJudgeReview | null) => void>();
  mockQuery.mockImplementation(
    (_fn: unknown, args: { iterationId: string }) =>
      new Promise<TrialJudgeReview | null>((resolve) => {
        pending.set(args.iterationId, resolve);
      }),
  );
  return async (iterationId: string, row: TrialJudgeReview | null) => {
    const resolve = pending.get(iterationId);
    if (!resolve) throw new Error(`no pending read for ${iterationId}`);
    await act(async () => {
      resolve(row);
    });
  };
}

describe("TrialJudgeReviewPanel trial scoping", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue(undefined);
  });

  it("offers neither a label nor a reveal while the read is pending", () => {
    deferredReads();
    render(<TrialJudgeReviewPanel iterationId="it_1" judgeCase={JUDGE_CASE} />);
    expect(screen.getByTestId("trial-review-loading")).toBeTruthy();
    expect(screen.queryByTestId("trial-review-control")).toBeNull();
    expect(screen.queryByRole("button", { name: "pass" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reveal judge verdict" }),
    ).toBeNull();
    // The verdict itself is hidden too: a reveal before the label is known
    // would un-blind the label about to be given.
    expect(screen.queryByText(/The answer never named the file/)).toBeNull();
  });

  it("drops the previous trial's label the moment the trial changes", async () => {
    const settle = deferredReads();
    const { rerender } = render(
      <TrialJudgeReviewPanel iterationId="it_1" judgeCase={JUDGE_CASE} />,
    );
    await settle("it_1", review("fail"));
    expect(screen.getByTestId("trial-review-provenance").textContent).toContain(
      "Reviewer: fail",
    );

    rerender(
      <TrialJudgeReviewPanel
        iterationId="it_2"
        judgeCase={{ ...JUDGE_CASE, iterationId: "it_2" }}
      />,
    );
    // Not trial 1's label, and not the label control either — nothing is
    // known about trial 2 yet.
    expect(screen.queryByTestId("trial-review-provenance")).toBeNull();
    expect(screen.queryByTestId("trial-review-control")).toBeNull();
    expect(screen.getByTestId("trial-review-loading")).toBeTruthy();

    await settle("it_2", review("pass"));
    expect(screen.getByTestId("trial-review-provenance").textContent).toContain(
      "Reviewer: pass",
    );
    expect(screen.queryByTestId("trial-review-loading")).toBeNull();
  });

  it("submits a label against the trial that was loaded, not the one before", async () => {
    const user = userEvent.setup();
    const settle = deferredReads();
    const { rerender } = render(
      <TrialJudgeReviewPanel iterationId="it_1" judgeCase={JUDGE_CASE} />,
    );
    await settle("it_1", null);
    expect(screen.getByTestId("trial-review-control")).toBeTruthy();

    rerender(
      <TrialJudgeReviewPanel
        iterationId="it_2"
        judgeCase={{ ...JUDGE_CASE, iterationId: "it_2" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "pass" })).toBeNull();

    await settle("it_2", null);
    await user.click(screen.getByRole("button", { name: "pass" }));
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith({
      iterationId: "it_2",
      reviewerVerdict: "pass",
      blind: true,
    });
  });

  it("ignores a read that lands after the trial has moved on", async () => {
    const settle = deferredReads();
    const { rerender } = render(
      <TrialJudgeReviewPanel iterationId="it_1" judgeCase={JUDGE_CASE} />,
    );
    rerender(
      <TrialJudgeReviewPanel
        iterationId="it_2"
        judgeCase={{ ...JUDGE_CASE, iterationId: "it_2" }}
      />,
    );
    // Trial 1's answer arrives late. It must not be taken for trial 2's.
    await settle("it_1", review("fail"));
    expect(screen.queryByTestId("trial-review-provenance")).toBeNull();
    expect(screen.getByTestId("trial-review-loading")).toBeTruthy();

    await settle("it_2", null);
    expect(screen.getByTestId("trial-review-control")).toBeTruthy();
  });
});
