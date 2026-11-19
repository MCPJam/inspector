import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnalyticsConsent,
  hasAnalyticsConsent,
  reapplyAnalyticsConsent,
  setAnalyticsConsent,
} from "../analytics-consent";
import { options } from "../PosthogUtils";

function client() {
  return {
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    set_config: vi.fn(),
  };
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("analytics consent", () => {
  it("keeps analytics on where the server says no consent is needed", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
    expect(hasAnalyticsConsent()).toBe(true);
    expect(options.opt_out_capturing_by_default).toBe(false);
    expect(options.opt_out_persistence_by_default).toBe(false);
  });

  it("starts PostHog opted out until a visitor who needs consent allows it", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    expect(options.opt_out_capturing_by_default).toBe(true);
    expect(options.opt_out_persistence_by_default).toBe(true);
    expect(options.disable_conversations).toBe(true);

    const posthog = client();
    setAnalyticsConsent(posthog, "granted");
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({
      captureEventName: false,
    });
    expect(options.opt_out_capturing_by_default).toBe(false);
  });

  it("treats a document without the server's answer as needing consent", () => {
    delete window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__;
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it("records a refusal and opts PostHog out", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    const posthog = client();
    setAnalyticsConsent(posthog, "denied");
    expect(getAnalyticsConsent()).toBe("denied");
    expect(posthog.opt_out_capturing).toHaveBeenCalled();
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it("stops replay and Conversations that started before a withdrawal", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    window.localStorage.setItem("mcpjam-analytics-consent", "granted");
    const posthog = {
      ...client(),
      sessionRecording: { startIfEnabledOrStop: vi.fn() },
      conversations: { reset: vi.fn() },
    };
    setAnalyticsConsent(posthog, "denied");
    expect(posthog.sessionRecording.startIfEnabledOrStop).toHaveBeenCalledTimes(
      1,
    );
    expect(posthog.conversations.reset).toHaveBeenCalledTimes(1);
    expect(posthog.opt_out_capturing.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.sessionRecording.startIfEnabledOrStop.mock.invocationCallOrder[0],
    );
  });

  it("keeps Conversations off in the live config after a withdrawal", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    window.localStorage.setItem("mcpjam-analytics-consent", "granted");
    const posthog = { ...client(), conversations: { reset: vi.fn() } };
    setAnalyticsConsent(posthog, "denied");
    expect(posthog.set_config).toHaveBeenCalledWith({
      disable_conversations: true,
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
    });
    expect(posthog.set_config.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.conversations.reset.mock.invocationCallOrder[0],
    );
  });

  it("keeps a stored refusal where the server would not ask", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
    window.localStorage.setItem("mcpjam-analytics-consent", "denied");
    expect(hasAnalyticsConsent()).toBe(false);
    expect(options.opt_out_capturing_by_default).toBe(true);
    expect(options.opt_out_persistence_by_default).toBe(true);
    expect(options.disable_conversations).toBe(true);
  });

  it("keeps a withdrawal through a posthog-js reset", async () => {
    // Granted on an earlier visit, so posthog-js initialised opted in.
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    window.localStorage.setItem("mcpjam-analytics-consent", "granted");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    const { PostHog } = await import("posthog-js");
    const posthog = new PostHog();
    posthog.init("phc_consent_reset_test", {
      ...options,
      api_host: window.location.origin,
      persistence: "memory",
      advanced_disable_flags: true,
      disable_session_recording: true,
      capture_pageview: false,
      autocapture: false,
    });
    expect(posthog.is_capturing()).toBe(true);

    setAnalyticsConsent(posthog, "denied");
    posthog.reset();

    expect(posthog.is_capturing()).toBe(false);
  });

  it("restores a granted choice after a reset, and nothing else", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    const undecided = client();
    reapplyAnalyticsConsent(undecided);
    expect(undecided.opt_in_capturing).not.toHaveBeenCalled();

    window.localStorage.setItem("mcpjam-analytics-consent", "granted");
    const granted = client();
    reapplyAnalyticsConsent(granted);
    expect(granted.opt_in_capturing).toHaveBeenCalledTimes(1);
  });
});
