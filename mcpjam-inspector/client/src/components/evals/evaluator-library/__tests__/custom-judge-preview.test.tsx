import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test";
import { CustomJudgePreview } from "../custom-judge-preview";

const convex = vi.hoisted(() => ({
  trials: [
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
  useQuery: () => convex.trials,
  useAction: () => convex.preview,
}));

const judge = {
  id: "states-the-sum",
  label: "States the sum",
  prompt: "Does {{final_answer}} say 42?",
  output: { kind: "passfail" as const },
};

describe("CustomJudgePreview", () => {
  it("grades the newest trial with the draft and shows the verdict", async () => {
    convex.preview.mockResolvedValue({
      ok: true,
      prompt: "Grader's question: ...",
      result: { status: "scored", value: 1, passed: true, reason: "Says 42." },
    });
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    fireEvent.click(screen.getByRole("button", { name: "Test on a past run" }));
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
      screen.getByRole("button", { name: "Test on a past run" }),
    ).toBeDisabled();
  });

  it("asks for a run first on a suite with no finished trials", () => {
    convex.trials = [];
    renderWithProviders(<CustomJudgePreview suiteId="s1" judge={judge} />);
    expect(
      screen.getByText("Run this suite once to test a judge on a past trial."),
    ).toBeInTheDocument();
  });
});
