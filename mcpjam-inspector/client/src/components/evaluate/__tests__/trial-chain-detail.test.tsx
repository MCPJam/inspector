/**
 * The coverage line on the trial's chain.
 *
 * `toTrialCardViews` is pinned by its own test to never set `detail` — it has
 * no idea what a case authors. The panel merges the line on top, so the three
 * existing mounts that pass nothing keep rendering exactly what they did.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrialChainPanel } from "../trial-chain-panel";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

const chain = {
  status: "verified",
  stages: [
    { stage: "connection", state: "passed" },
    { stage: "discovery", state: "passed" },
    { stage: "selection", state: "passed" },
    { stage: "call", state: "passed" },
    { stage: "response", state: "passed" },
    { stage: "userValue", state: "passed" },
  ],
  firstFailedStage: null,
} as unknown as EvalRunDecisionChain;

describe("TrialChainPanel detail", () => {
  it("renders no coverage line when the caller passes none", () => {
    const { container } = render(<TrialChainPanel chain={chain} />);
    expect(container.textContent).not.toContain("Observed by the runner ·");
    expect(container.textContent).not.toContain("Nothing checks this");
  });

  it("renders the line the caller supplies, on that card only", () => {
    render(
      <TrialChainPanel
        chain={chain}
        detailByStage={{
          selection: { label: "2 gates · 1 warn", toneClass: "x" },
        }}
      />,
    );
    expect(screen.getByText("2 gates · 1 warn")).toBeTruthy();
  });

  it("can say a link has nothing checking it, with what would", () => {
    render(
      <TrialChainPanel
        chain={chain}
        detailByStage={{
          userValue: {
            label: "Nothing checks this · 2 suggested",
            toneClass: "x",
          },
        }}
      />,
    );
    expect(screen.getByText("Nothing checks this · 2 suggested")).toBeTruthy();
  });

  it("renders a footer inside the stage the reader selected", async () => {
    // A chain with nothing failed selects no stage by default, so the footer
    // appears only once a card is opened — which is the point: it is a
    // "harden this link" affordance, not a permanent banner.
    render(
      <TrialChainPanel
        chain={chain}
        stageFooter={(stage) => <span>footer for {stage}</span>}
      />,
    );
    expect(screen.queryByText(/^footer for/)).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByTestId("stage-chain-card-selection"));
    expect(screen.getByText(/^footer for/)).toBeTruthy();
  });
});
