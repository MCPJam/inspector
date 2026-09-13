import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
} from "@mcpjam/sdk/contract";
import { TrialChainPanel } from "../trial-chain-panel";

describe("trial chain report", () => {
  it("opens the recorded failure and switches evidence when selecting another stage", async () => {
    const user = userEvent.setup();
    const chain = {
      status: "verified",
      firstFailedStage: "selection",
      stages: USER_VALUE_STAGES.map((stage) => ({
        stage,
        state: stage === "selection" ? "failed" : "passed",
      })),
    } as EvalRunDecisionChain;
    render(
      <TrialChainPanel
        chain={chain}
        layout="report"
        nextAction="Inspect the expected tools."
      />,
    );
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "selection",
    );
    expect(screen.getByTestId("trial-stage-next-action")).toHaveTextContent(
      "Inspect the expected tools.",
    );
    const stages = within(
      screen.getByRole("navigation", { name: "Iteration stages" }),
    );
    expect(stages.getAllByRole("button")).toHaveLength(6);
    await user.click(stages.getByRole("button", { name: /01 Connection/ }));
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "connection",
    );
    expect(screen.queryByTestId("trial-stage-next-action")).toBeNull();
  });
});

describe("trial chain report under a mask", () => {
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

  it("keeps all six stages, masks only the named one, and opens it", () => {
    render(
      <TrialChainPanel
        chain={judgeFailedChain}
        layout="report"
        maskedStage="userValue"
        nextAction="Read the judge's rationale."
        stageFooter={(stage) => <div data-testid={`footer-${stage}`} />}
      />,
    );
    const stages = within(
      screen.getByRole("navigation", { name: "Iteration stages" }),
    );
    expect(stages.getAllByRole("button")).toHaveLength(6);
    expect(
      stages.getByRole("button", { name: /06 User value/ }),
    ).toHaveAccessibleName(
      "06 User value: hidden until you label this iteration",
    );
    // The masked card is the one open, and it is the masked frame — not the
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
      <TrialChainPanel
        chain={judgeFailedChain}
        layout="report"
        maskedStage="userValue"
      />,
    );
    const stages = within(
      screen.getByRole("navigation", { name: "Iteration stages" }),
    );
    expect(
      stages.getByRole("button", { name: /03 Selection/ }),
    ).not.toHaveAccessibleName(/hidden until/);
    await user.click(stages.getByRole("button", { name: /03 Selection/ }));
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "selection",
    );
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
  });

  it("with no mask, a judge-decided chain opens the failure as before", () => {
    render(<TrialChainPanel chain={judgeFailedChain} layout="report" />);
    expect(screen.getByTestId("trial-stage-detail-card")).toHaveAttribute(
      "data-stage",
      "userValue",
    );
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
  });
});
