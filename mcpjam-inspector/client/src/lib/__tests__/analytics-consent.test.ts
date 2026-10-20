import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnalyticsConsent,
  hasAnalyticsConsent,
  reapplyAnalyticsConsent,
  setAnalyticsConsent,
} from "../analytics-consent";
import { options } from "../PosthogUtils";

function client() {
  return { opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() };
}

afterEach(() => {
  window.localStorage.clear();
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
