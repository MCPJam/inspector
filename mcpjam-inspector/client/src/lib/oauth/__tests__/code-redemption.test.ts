import { describe, expect, it, vi } from "vitest";
import type { OAuthFlowState, OAuthFlowStep } from "@mcpjam/sdk/browser";
import { redeemAuthorizationCode } from "../code-redemption";

// A step the SDK might add between the callback and the token request. The
// order below stands in for the SDK's own, which bounds the redemption.
const ADDED_STEP = "verify_authorization_response" as OAuthFlowStep;
vi.mock("@mcpjam/sdk/browser", () => {
  const order = [
    "idle",
    "authorization_request",
    "received_authorization_code",
    "verify_authorization_response",
    "token_request",
    "received_access_token",
  ];
  return {
    getStepIndex: (step: string) =>
      order.includes(step) ? order.indexOf(step) : Number.MAX_SAFE_INTEGER,
  };
});

const NEXT: Record<string, OAuthFlowState["currentStep"]> = {
  authorization_request: "received_authorization_code",
  received_authorization_code: "token_request",
  token_request: "received_access_token",
};

function scriptedMachine(initial: Partial<OAuthFlowState>, next = NEXT) {
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
        currentStep: next[step] ?? step,
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

  it("also runs a step the SDK places between the callback and the token request", async () => {
    const { machine, flowState, startedFrom } = scriptedMachine(
      { currentStep: "authorization_request" },
      {
        ...NEXT,
        received_authorization_code: ADDED_STEP,
        [ADDED_STEP]: "token_request",
      },
    );
    await redeemAuthorizationCode(machine, flowState);
    expect(startedFrom).toEqual([
      "authorization_request",
      "received_authorization_code",
      ADDED_STEP,
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
