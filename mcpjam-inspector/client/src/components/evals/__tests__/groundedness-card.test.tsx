/**
 * Groundedness card — the second named judge's run-detail panel.
 *
 * What these protect: the never-auto-spend affordance (idle state offers the
 * button, nothing more), the evidence-first result rendering (unsupported
 * claims are the finding), and the advisory framing.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GroundednessCard } from "../groundedness-card";
import type { EvalSuiteRun } from "../types";

const RUN = { _id: "run_1", status: "completed" } as unknown as EvalSuiteRun;

const RESULT: NonNullable<EvalSuiteRun["groundedness"]> = {
  summary: "One case grounded; one invents its order total.",
  generatedAt: 1,
  modelUsed: "openai/gpt-5.4-mini",
  threshold: 0.7,
  cases: [
    {
      caseKey: "case-weather",
      score: 0.95,
      passed: true,
      reason: "Every figure traces to the weather tool result.",
      unsupportedClaims: [],
    },
    {
      caseKey: "case-order",
      score: 0.2,
      passed: false,
      reason: "The order total appears nowhere in the trajectory.",
      unsupportedClaims: ["your order total is $42"],
    },
  ],
};

function renderCard(over: Partial<Parameters<typeof GroundednessCard>[0]> = {}) {
  const onRun = vi.fn();
  render(
    <GroundednessCard
      run={RUN}
      groundedness={null}
      pending={false}
      requested={false}
      failedGeneration={false}
      error={null}
      onRun={onRun}
      {...over}
    />,
  );
  return { onRun };
}

describe("GroundednessCard", () => {
  it("idle state offers Run judge and never auto-spends", async () => {
    const user = userEvent.setup();
    const { onRun } = renderCard();
    expect(onRun).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("groundedness-run"));
    expect(onRun).toHaveBeenCalledWith(false);
  });

  it("renders the headline count and leads each failing case with its unsupported claims", () => {
    renderCard({ groundedness: RESULT });
    expect(screen.getByTestId("groundedness-headline").textContent).toBe(
      "1/2 grounded",
    );
    const cases = screen.getAllByTestId("groundedness-case");
    expect(cases).toHaveLength(2);
    const failing = cases[1];
    expect(
      within(failing).getByTestId("groundedness-unsupported-claim").textContent,
    ).toContain("your order total is $42");
    // Advisory framing is present in the header.
    expect(screen.getByText("advisory")).toBeTruthy();
  });

  it("re-run forces, so a completed verdict can be regraded", async () => {
    const user = userEvent.setup();
    const { onRun } = renderCard({ groundedness: RESULT });
    await user.click(screen.getByTestId("groundedness-rerun"));
    expect(onRun).toHaveBeenCalledWith(true);
  });

  it("shows progress while pending and no run affordance", () => {
    renderCard({ pending: true });
    expect(screen.queryByTestId("groundedness-run")).toBeNull();
    expect(
      screen.getByText("Checking claims against tool evidence…"),
    ).toBeTruthy();
  });
});
