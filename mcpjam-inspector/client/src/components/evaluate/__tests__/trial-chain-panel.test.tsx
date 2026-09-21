import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
} from "@mcpjam/sdk/contract";
import { TrialChainPanel } from "../trial-chain-panel";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

describe("iteration chain cards under a mask", () => {
  const judgeFailedChain = {
    status: "verified",
    firstFailedStage: "userValue",
    stages: USER_VALUE_STAGES.map((stage) =>
      stage === "userValue"
        ? {
            stage,
            state: "failed",
            reason: "judgeFailed",
            evidence: { judgeReasons: ["The answer never named the file."] },
          }
        : { stage, state: "passed", reason: "observed" },
    ),
  } as EvalRunDecisionChain;

  it("keeps all six cards, masks only the named one, and opens it", () => {
    render(
      <TrialChainPanel
        chain={judgeFailedChain}
        maskedStage="userValue"
        nextAction="Read the judge's rationale."
        stageFooter={(stage) => <div data-testid={`footer-${stage}`} />}
      />,
    );
    for (const stage of USER_VALUE_STAGES) {
      expect(screen.getByTestId(`stage-chain-card-${stage}`)).toBeTruthy();
    }
    // The masked card is the one open, and it is the masked frame, not the
    // detail card, which would print the state and the judge's reasons.
    expect(screen.getByTestId("trial-stage-masked")).toHaveAttribute(
      "data-stage",
      "userValue",
    );
    expect(screen.queryByTestId("trial-stage-detail-card")).toBeNull();
    expect(screen.queryByTestId("trial-stage-next-action")).toBeNull();
    expect(document.body.textContent).not.toContain("never named the file");
    expect(document.body.textContent).not.toContain("below the partial floor");
    // The footer is where the reviewer labels, so it still renders.
    expect(screen.getByTestId("footer-userValue")).toBeInTheDocument();
  });

  it("leaves the other stages readable and unmasked", async () => {
    const user = userEvent.setup();
    render(
      <TrialChainPanel chain={judgeFailedChain} maskedStage="userValue" />,
    );
    await user.click(screen.getByTestId("stage-chain-card-selection"));
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "selection",
    );
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
  });

  it("with no mask, a judge-decided chain opens the failure as before", () => {
    render(<TrialChainPanel chain={judgeFailedChain} />);
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "userValue",
    );
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
  });
});
