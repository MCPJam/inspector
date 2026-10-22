import { describe, expect, it } from "vitest";
import type { OAuthFlowState } from "@mcpjam/sdk/browser";
import { redeemAuthorizationCode } from "../code-redemption";

const NEXT: Record<string, OAuthFlowState["currentStep"]> = {
  authorization_request: "received_authorization_code",
  received_authorization_code: "token_request",
  token_request: "received_access_token",
};

function scriptedMachine(initial: Partial<OAuthFlowState>) {
  const flowState = {
    current: { isInitiatingAuth: false, ...initial } as OAuthFlowState,
  };
  const startedFrom: string[] = [];
  const machine = {
    proceedToNextStep: async () => {
      const step = flowState.current.currentStep;
      startedFrom.push(step);
      flowState.current = {
        ...flowState.current,
        currentStep: NEXT[step] ?? step,
      };
    },
  };
  return { machine, flowState, startedFrom };
}

describe("redeemAuthorizationCode", () => {
  it("runs from the callback through the token exchange and stops there", async () => {
    const { machine, flowState, startedFrom } = scriptedMachine({
      currentStep: "authorization_request",
    });
    await redeemAuthorizationCode(machine, flowState);
    expect(startedFrom).toEqual([
      "authorization_request",
      "received_authorization_code",
      "token_request",
    ]);
  });

  it("does not start while another step is in flight", async () => {
    const { machine, flowState, startedFrom } = scriptedMachine({
      currentStep: "token_request",
      isInitiatingAuth: true,
    });
    await redeemAuthorizationCode(machine, flowState);
    expect(startedFrom).toEqual([]);
  });
});
