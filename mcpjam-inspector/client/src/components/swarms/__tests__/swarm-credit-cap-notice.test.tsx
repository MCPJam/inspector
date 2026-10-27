import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { maxConversations, usableCredits } from "../swarm-credit-cap";
import { SwarmCreditCapNotice } from "../swarm-credit-cap-notice";

const TEST_ID = "swarm-credit-cap-notice";

beforeEach(() => {
  useMCPJamLimitDialogStore.setState({
    authStatus: "signedIn",
    isOpen: false,
    surface: null,
    shortfall: null,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
  });
});

describe("SwarmCreditCapNotice", () => {
  it("names the balance and the max the backend estimate allows", () => {
    // The estimate's output for one hosted environment on an enforced v2 rate
    // card at 6 turns: 6 token credits and the 30-credit per-turn fee.
    const usable = usableCredits({
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyResetAt: 0,
      freeDailyCreditsRemaining: 300,
      freeDailyCreditsTotal: 300,
      walletLocked: false,
      billingModel: "daily",
      perCallMinimumCredits: 25,
    });
    const max = maxConversations({
      usable,
      freeLeft: 0,
      perEnvironment: [
        {
          environmentId: "env-1",
          tokenCredits: 6,
          feeCredits: 30,
          freeEligible: true,
        },
      ],
    });

    render(
      <SwarmCreditCapNotice
        credits={300}
        max={max ?? -1}
        data-testid={TEST_ID}
      />,
    );

    const notice = screen.getByTestId(TEST_ID);
    expect(notice).toHaveTextContent(/^You have 300 credits left/);
    expect(notice).toHaveTextContent(
      /That covers up to 7 conversations, the most you can run in this swarm\./,
    );
    expect(notice).not.toHaveAttribute("role", "alert");
  });

  it("says how many conversations to remove above the max", () => {
    render(
      <SwarmCreditCapNotice
        credits={140}
        max={7}
        count={9}
        data-testid={TEST_ID}
      />,
    );
    expect(screen.getByTestId(TEST_ID)).toHaveTextContent(
      /That covers up to 7 conversations, and this swarm has 9\. Remove 2 conversations to continue\./,
    );
  });

  it("asks a locked swarm to lower iterations, or to start over at one", () => {
    const { rerender } = render(
      <SwarmCreditCapNotice
        credits={140}
        max={7}
        count={9}
        locked
        data-testid={TEST_ID}
      />,
    );
    expect(screen.getByTestId(TEST_ID)).toHaveTextContent(
      /and this swarm has 9\. Lower iterations to continue\./,
    );

    rerender(
      <SwarmCreditCapNotice
        credits={140}
        max={7}
        count={9}
        locked
        iterationsAtMinimum
        data-testid={TEST_ID}
      />,
    );
    expect(screen.getByTestId(TEST_ID)).toHaveTextContent(
      /Go back and start a new swarm with fewer goals\./,
    );
  });

  it("opens the swarm credits dialog at max 0 without locking MCPJam models", () => {
    render(
      <SwarmCreditCapNotice
        credits={12}
        max={0}
        conversationCredits={20}
        organizationId="org-1"
        data-testid={TEST_ID}
      />,
    );
    expect(screen.getByTestId(TEST_ID)).toHaveTextContent(
      /That isn't enough for one conversation\. Add credits to generate personas for this swarm\./,
    );

    fireEvent.click(screen.getByRole("button", { name: "Get more credits" }));

    const state = useMCPJamLimitDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.surface).toBe("swarm");
    expect(state.shortfall).toEqual({
      creditsRemaining: 12,
      creditsRequired: 20,
    });
    expect(state.outOfCreditsHit).toBe(false);
  });
});
