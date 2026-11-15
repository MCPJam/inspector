import { describe, expect, it } from "vitest";
import { getStepIndex, type OAuthFlowState } from "@mcpjam/sdk/browser";
import {
  CODE_REDEMPTION_STEPS,
  redeemAuthorizationCode,
} from "../code-redemption";

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

  it("lists every step the SDK orders from the callback through the token request", () => {
    // Fails when the SDK adds a step in that range. Decide whether the new
    // step is safe to run without a click before adding it to the list.
    const first = getStepIndex("authorization_request");
    const last = getStepIndex("token_request");
    expect(
      [...CODE_REDEMPTION_STEPS].map(getStepIndex).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: last - first + 1 }, (_, i) => first + i));
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
