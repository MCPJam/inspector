import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test";
import { CustomJudgePreview } from "../custom-judge-preview";

const convex = vi.hoisted(() => ({
  iterations: [
    {
      iterationId: "it1",
      runNumber: 36,
      title: "Addition returns a numeric result",
      result: "passed",
    },
  ] as unknown[],
  preview: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: () => convex.iterations,
  useAction: () => convex.preview,
}));

const judge = {
  id: "states-the-sum",
  label: "States the sum",
  prompt: "Does {{final_answer}} say 42?",
  output: { kind: "passfail" as const },
};

describe("CustomJudgePreview", () => {
  it("grades the newest iteration with the draft and shows the verdict", async () => {
    convex.preview.mockResolvedValue({
      ok: true,
      prompt: "Grader's question: ...",
      result: { status: "scored", value: 1, passed: true, reason: "Says 42." },
    });
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(screen.getByRole("button", { name: "Test on a past iteration" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Says 42."),
    );
    expect(convex.preview).toHaveBeenCalledWith({
      suiteId: "s1",
      iterationId: "it1",
      judge,
    });
  });

  it("does not spend a call on a draft the backend would refuse", () => {
    renderWithProviders(
      <CustomJudgePreview
        suiteId="s1"
        judge={judge}
        disabledReason="Give the judge a name."
      />,
    );
    expect(
      screen.getByRole("button", { name: "Test on a past iteration" }),
    ).toBeDisabled();
  });

  it("asks for another iteration when the selected one cannot be graded", async () => {
    convex.preview.mockResolvedValue({
      ok: false,
      reason: "iteration_not_gradable",
    });
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(screen.getByRole("button", { name: "Test on a past iteration" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This iteration cannot be graded. Choose another iteration.",
    );
  });

  it.each([
    ["spend_budget_reached", "spend budget is reached"],
    ["spend_cap_exceeded", "reached its AI spending limit"],
    ["missing_api_key", "has no provider key"],
    ["org_keys_required", "requires its own provider keys"],
  ])("says why a refused test did not run: %s", async (reason, copy) => {
    convex.preview.mockResolvedValue({ ok: false, reason });
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Test on a past iteration" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(copy);
  });

  it("says each test is a charged call to the judge the run used", () => {
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    expect(
      screen.getByText(
        "Graded by the judge this run used, as one charged call. Saves nothing.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the dialog test and grader input collapsed until opened", async () => {
    convex.preview.mockReset().mockResolvedValue({
      ok: true,
      prompt: "Grader's question: ...",
      result: { status: "scored", value: 1, passed: true, reason: "Says 42." },
    });
    renderWithProviders(
      <CustomJudgePreview inDialog suiteId="s1" judge={judge} />,
    );
    const preview = screen.getByText("Test on a past iteration");
    expect(preview.parentElement).not.toHaveAttribute("open");
    fireEvent.click(preview);
    expect(preview.parentElement).toHaveAttribute("open");
    expect(convex.preview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Says 42.");
    const evidence = screen.getByText("What the judge read");
    expect(evidence.parentElement).not.toHaveAttribute("open");
    fireEvent.click(evidence);
    expect(evidence.parentElement).toHaveAttribute("open");
  });

  it("shows a failed judge call as a failed test, with its reason", async () => {
    convex.preview.mockResolvedValue({
      ok: true,
      prompt: null,
      result: {
        status: "error",
        error: "judge_output_invalid",
        reason: "The score 1.4 is outside 0 to 1.",
      },
    });
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Test on a past iteration" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The score 1.4 is outside 0 to 1.",
    );
  });

  it("says why a judge returned no answer when the result has no reason", async () => {
    convex.preview.mockResolvedValue({
      ok: true,
      prompt: null,
      result: { status: "error", error: "judge_no_output" },
    });
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Test on a past iteration" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The judge returned no answer. Lower its reasoning effort or shorten the question, then grade the run again.",
    );
  });

  it("asks to wait after testing the same iteration twice in a row", async () => {
    convex.preview.mockRejectedValue(
      Object.assign(new Error("ConvexError"), {
        data: {
          code: "EVAL_CUSTOM_JUDGE_PREVIEW_COOLDOWN",
          message: "Slow down.",
        },
      }),
    );
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Test on a past iteration" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You tested this judge on this iteration moments ago. Wait a few seconds, then try again.",
    );
  });

  it("asks for a run first on a suite with no finished iterations", () => {
    convex.iterations = [];
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    expect(
      screen.getByText("Run this suite once to test a judge on a past iteration."),
    ).toBeInTheDocument();
  });
});
