/**
 * The strip says how far the trial got. It does not say the verdict word —
 * that lives on the Scorecard group heading, beside the rows it explains.
 * Nothing states the same thing twice.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import { StageStrip } from "../case-scorecard/stage-strip";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

const chain = (over: Record<string, unknown> = {}) =>
  ({
    status: "verified",
    stages: [
      { stage: "connection", state: "passed" },
      { stage: "discovery", state: "passed" },
      {
        stage: "selection",
        state: "failed",
        reason: "missingToolCall",
        evidence: { predicateReasons: ['tool "list_teams" was never called'] },
      },
      { stage: "call", state: "notReached" },
      { stage: "response", state: "notReached" },
      { stage: "userValue", state: "notReached" },
    ],
    firstFailedStage: "selection",
    ...over,
  }) as unknown as EvalRunDecisionChain;

describe("StageStrip", () => {
  it("shows all six stages, including the three nobody authors", () => {
    render(<StageStrip chain={chain()} />);
    for (const stage of [
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]) {
      expect(screen.getByTestId(`stage-chip-${stage}`)).toBeTruthy();
    }
  });

  it("carries state as data, not as a repeated word", () => {
    render(<StageStrip chain={chain()} />);
    expect(screen.getByTestId("stage-chip-selection")).toHaveAttribute(
      "data-state",
      "failed",
    );
    // The word belongs to the group heading; repeating it here is the
    // duplication this replaced.
    expect(
      screen.getByTestId("stage-chip-selection").textContent,
    ).not.toContain("failed");
  });

  it("opens a stage's detail on click", async () => {
    const user = userEvent.setup();
    render(<StageStrip chain={chain()} />);
    expect(screen.queryByTestId("stage-strip-detail")).toBeNull();
    await user.click(screen.getByTestId("stage-chip-selection"));
    const detail = screen.getByTestId("stage-strip-detail");
    expect(detail.textContent).toContain("failed");
    expect(detail.textContent).toContain("list_teams");
  });

  it("is the only home for a stage that has no rows", async () => {
    // Nothing authors Connection, so it appears in no Scorecard group. If the
    // chip did not open, the stage would be unreachable.
    const user = userEvent.setup();
    render(<StageStrip chain={chain()} />);
    await user.click(screen.getByTestId("stage-chip-connection"));
    expect(screen.getByTestId("stage-strip-detail").textContent).toContain(
      "Connection",
    );
  });

  it("closes the detail when the same chip is clicked again", async () => {
    const user = userEvent.setup();
    render(<StageStrip chain={chain()} />);
    await user.click(screen.getByTestId("stage-chip-selection"));
    await user.click(screen.getByTestId("stage-chip-selection"));
    expect(screen.queryByTestId("stage-strip-detail")).toBeNull();
  });

  it("renders nothing while the chain has not landed", () => {
    // Absent is not "no chain" — claiming the latter would be a statement
    // about the trial rather than about the read.
    const { container } = render(<StageStrip chain={null} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a chain the server declined to vouch for", () => {
    const { container } = render(
      <StageStrip chain={chain({ status: "unverified" })} />,
    );
    expect(container.textContent).toBe("");
  });

  it("drops a selection when the trial changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StageStrip chain={chain()} resetKey="a" />);
    await user.click(screen.getByTestId("stage-chip-selection"));
    expect(screen.getByTestId("stage-strip-detail")).toBeTruthy();
    rerender(<StageStrip chain={chain()} resetKey="b" />);
    // A carried selection would open a stage the new trial may not have
    // broken at.
    expect(screen.queryByTestId("stage-strip-detail")).toBeNull();
  });
});
