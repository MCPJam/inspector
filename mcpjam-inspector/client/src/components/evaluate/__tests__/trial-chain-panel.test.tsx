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
