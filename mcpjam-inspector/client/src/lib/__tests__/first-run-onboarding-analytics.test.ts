import { afterEach, describe, expect, it, vi } from "vitest";

const trackMock = vi.hoisted(() => vi.fn());

vi.mock("../analytics", () => ({ track: trackMock }));

import {
  trackFirstRunConnectionCancelled,
  trackFirstRunConnectionFailed,
  trackFirstRunConnectionStarted,
  trackFirstRunConnectionSucceeded,
  trackFirstRunOnboardingEntered,
  trackFirstRunOnboardingScreenViewed,
  trackFirstRunPlaygroundOpened,
  trackFirstRunServerSelected,
  trackFirstRunSetupLater,
} from "../first-run-onboarding-analytics";

describe("first-run onboarding analytics", () => {
  afterEach(() => trackMock.mockReset());

  it("captures the approved screen-only entry and impression payloads", () => {
    trackFirstRunOnboardingEntered("welcome");
    trackFirstRunOnboardingScreenViewed("server_choice");
    trackFirstRunSetupLater();

    expect(trackMock.mock.calls).toEqual([
      [
        "first_run_onboarding_entered",
        { location: "first_run_onboarding", screen: "welcome" },
      ],
      [
        "first_run_onboarding_screen_viewed",
        { location: "first_run_onboarding", screen: "server_choice" },
      ],
      [
        "first_run_onboarding_setup_later_clicked",
        { location: "first_run_onboarding", screen: "server_choice" },
      ],
    ]);
  });

  it("captures only categorical connection context and tool count", () => {
    const context = {
      serverKind: "personal" as const,
      transport: "stdio" as const,
      authentication: "oauth" as const,
    };

    trackFirstRunServerSelected(context);
    trackFirstRunConnectionStarted(context);
    trackFirstRunConnectionSucceeded(context, "tools_loaded", 3);
    trackFirstRunConnectionFailed(context, "handshake");
    trackFirstRunConnectionCancelled(context, "loading_tools");
    trackFirstRunPlaygroundOpened(context, 3);

    for (const [, props] of trackMock.mock.calls) {
      expect(props).toEqual(
        expect.objectContaining({
          location: "first_run_onboarding",
          server_kind: "personal",
          transport: "stdio",
          authentication: "oauth",
        }),
      );
    }
    expect(trackMock).toHaveBeenCalledWith(
      "first_run_onboarding_connection_succeeded",
      expect.objectContaining({ success_stage: "tools_loaded", tool_count: 3 }),
    );
    expect(trackMock).toHaveBeenCalledWith(
      "first_run_onboarding_connection_failed",
      expect.objectContaining({ failure_stage: "handshake" }),
    );
    expect(trackMock).toHaveBeenCalledWith(
      "first_run_onboarding_connection_cancelled",
      expect.objectContaining({ cancel_stage: "loading_tools" }),
    );
  });

  it("omits unavailable optional dimensions instead of inferring them", () => {
    const context = { serverKind: "personal" as const };

    trackFirstRunConnectionSucceeded(context, "handshake_only");
    trackFirstRunPlaygroundOpened(context);

    for (const [, props] of trackMock.mock.calls) {
      expect(props).not.toHaveProperty("transport");
      expect(props).not.toHaveProperty("authentication");
      expect(props).not.toHaveProperty("tool_count");
    }
  });

  it("cannot leak server configuration or errors through any payload", () => {
    const context = {
      serverKind: "demo" as const,
      transport: "http" as const,
      authentication: "none" as const,
    };

    trackFirstRunServerSelected(context);
    trackFirstRunConnectionStarted(context);
    trackFirstRunConnectionSucceeded(context, "handshake_only");
    trackFirstRunConnectionFailed(context, "validation");
    trackFirstRunConnectionCancelled(context, "connecting");
    trackFirstRunPlaygroundOpened(context);

    const serializedPayloads = JSON.stringify(
      trackMock.mock.calls.map(([, props]) => props),
    );
    for (const forbiddenKey of [
      "server_name",
      "serverName",
      "url",
      "command",
      "credentials",
      "headers",
      "error",
    ]) {
      expect(serializedPayloads).not.toContain(forbiddenKey);
    }
  });
});
