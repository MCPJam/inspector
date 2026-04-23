import { describe, expect, it } from "vitest";

import { mergeOAuthTraces, type OAuthTrace } from "../oauth-trace";

describe("oauth-trace mergeOAuthTraces", () => {
  it("collapses duplicate resume steps from the callback half of a local OAuth flow", () => {
    const interactiveTrace: OAuthTrace = {
      version: 1,
      source: "interactive_connect",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      currentStep: "authorization_request",
      steps: [
        {
          step: "request_client_registration",
          title: "Dynamic Client Registration",
          status: "success",
          message: "Registered OAuth client.",
          startedAt: 100,
          completedAt: 120,
        },
        {
          step: "authorization_request",
          title: "Authorization Request Ready",
          status: "success",
          message: "Redirecting to the OAuth provider.",
          startedAt: 130,
          completedAt: 150,
        },
      ],
      httpHistory: [],
    };

    const callbackTrace: OAuthTrace = {
      version: 1,
      source: "callback",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      currentStep: "complete",
      steps: [
        {
          step: "request_client_registration",
          title: "Dynamic Client Registration",
          status: "success",
          startedAt: 500,
          completedAt: 510,
        },
        {
          step: "authorization_request",
          title: "Authorization Request Ready",
          status: "success",
          startedAt: 520,
          completedAt: 530,
        },
        {
          step: "received_authorization_code",
          title: "Authorization Code Received",
          status: "success",
          startedAt: 540,
          completedAt: 550,
        },
        {
          step: "token_request",
          title: "Exchange Authorization Code",
          status: "success",
          startedAt: 560,
          completedAt: 580,
        },
        {
          step: "complete",
          title: "Flow Complete",
          status: "success",
          startedAt: 590,
          completedAt: 600,
        },
      ],
      httpHistory: [],
    };

    const mergedTrace = mergeOAuthTraces(interactiveTrace, callbackTrace);

    expect(mergedTrace.steps.map((step) => step.step)).toEqual([
      "request_client_registration",
      "authorization_request",
      "received_authorization_code",
      "token_request",
      "complete",
    ]);
    expect(mergedTrace.steps[0]?.message).toBe("Registered OAuth client.");
    expect(mergedTrace.steps[0]?.startedAt).toBe(100);
    expect(mergedTrace.steps[1]?.message).toBe(
      "Redirecting to the OAuth provider.",
    );
  });

  it("keeps the latest terminal state when hosted progress replays an earlier pending step", () => {
    const callbackScaffoldTrace: OAuthTrace = {
      version: 1,
      source: "hosted_callback",
      serverName: "learn",
      currentStep: "received_authorization_code",
      steps: [
        {
          step: "received_authorization_code",
          title: "Authorization Code Received",
          status: "success",
          message: "Hosted callback state restored.",
          startedAt: 1000,
          completedAt: 1010,
        },
      ],
      httpHistory: [],
    };

    const backendProgressTrace: OAuthTrace = {
      version: 1,
      source: "hosted_callback",
      serverName: "learn",
      currentStep: "token_request",
      steps: [
        {
          step: "received_authorization_code",
          title: "Authorization Code Received",
          status: "success",
          startedAt: 10,
          completedAt: 20,
        },
        {
          step: "token_request",
          title: "Exchange Authorization Code",
          status: "pending",
          startedAt: 30,
        },
      ],
      httpHistory: [],
    };

    const completedTrace: OAuthTrace = {
      version: 1,
      source: "hosted_callback",
      serverName: "learn",
      currentStep: "complete",
      steps: [
        {
          step: "token_request",
          title: "Exchange Authorization Code",
          status: "success",
          message: "Hosted token exchange succeeded.",
          startedAt: 40,
          completedAt: 50,
        },
        {
          step: "complete",
          title: "Flow Complete",
          status: "success",
          startedAt: 60,
          completedAt: 70,
        },
      ],
      httpHistory: [],
    };

    const mergedProgressTrace = mergeOAuthTraces(
      callbackScaffoldTrace,
      backendProgressTrace,
    );
    const mergedCompleteTrace = mergeOAuthTraces(
      mergedProgressTrace,
      completedTrace,
    );

    expect(
      mergedCompleteTrace.steps.filter((step) => step.step === "token_request"),
    ).toEqual([
      expect.objectContaining({
        status: "success",
        message: "Hosted token exchange succeeded.",
      }),
    ]);
    expect(
      mergedCompleteTrace.steps.filter(
        (step) => step.step === "received_authorization_code",
      ),
    ).toHaveLength(1);
  });
});
