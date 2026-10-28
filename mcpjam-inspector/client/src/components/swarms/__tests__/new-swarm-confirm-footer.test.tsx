import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewSwarmConfirmFooter } from "../new-swarm-confirm-footer";

const base = {
  personaTotal: 1,
  environmentCount: 1,
  reusedCount: 0,
  conversationCount: 3,
  max: null,
  notice: null,
  fundingState: { status: "idle" } as const,
  requestedRuns: 0,
  pendingGoals: 0,
  fundingNotice: null,
  errorMessage: null,
  launching: false,
  launchDisabled: false,
  onBack: vi.fn(),
  onContinue: vi.fn(),
};

describe("NewSwarmConfirmFooter", () => {
  it("disables Continue when there is a launch-blocked reason", () => {
    render(
      <NewSwarmConfirmFooter
        {...base}
        launchBlockedReason="Out of MCPJam credits"
      />,
    );
    expect(screen.getByTestId("new-swarm-launch")).toBeDisabled();
  });

  it("enables Continue with no reason and launchDisabled false", () => {
    render(<NewSwarmConfirmFooter {...base} launchBlockedReason={null} />);
    expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled();
  });
});
