import { afterEach, describe, expect, it, vi } from "vitest";
import {
  followAnalyticsConsentAcrossTabs,
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
    is_capturing: vi.fn(() => false),
    clear_opt_in_out_capturing: vi.fn(),
    set_config: vi.fn(),
  };
}

afterEach(() => {
  // Another tab's clear: drops this page's in-memory choice too.
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.restoreAllMocks();
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

  it("restores a renewed grant after a reset where the server would not ask", async () => {
    // Declined earlier, so posthog-js initialised opted out.
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
    window.localStorage.setItem("mcpjam-analytics-consent", "denied");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const { PostHog } = await import("posthog-js");
    const posthog = new PostHog();
    posthog.init("phc_consent_regrant_test", {
      ...options,
      api_host: window.location.origin,
      persistence: "memory",
      advanced_disable_flags: true,
      disable_session_recording: true,
      capture_pageview: false,
      autocapture: false,
    });
    expect(posthog.is_capturing()).toBe(false);

    setAnalyticsConsent(posthog, "granted");
    posthog.reset();
    expect(posthog.is_capturing()).toBe(true);

    const restored = client();
    reapplyAnalyticsConsent(restored);
    expect(restored.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("applies a withdrawal on this page when storage refuses it", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    window.localStorage.setItem("mcpjam-analytics-consent", "granted");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    setAnalyticsConsent(client(), "denied");
    expect(getAnalyticsConsent()).toBe("denied");
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it("stops posthog-js capturing after a withdrawal storage refused", async () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    const { PostHog } = await import("posthog-js");
    const posthog = new PostHog();
    posthog.init("phc_consent_readonly_test", {
      ...options,
      api_host: window.location.origin,
      persistence: "memory",
      advanced_disable_flags: true,
      disable_session_recording: true,
      capture_pageview: false,
      autocapture: false,
    });
    // posthog-js stores this grant under its own key.
    setAnalyticsConsent(posthog, "granted");
    expect(posthog.capture("before_withdrawal")).toBeDefined();

    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    setAnalyticsConsent(posthog, "denied");

    expect(posthog.is_capturing()).toBe(false);
    expect(posthog.capture("after_withdrawal")).toBeUndefined();
  });

  it("asks again on the next visit after a withdrawal storage refused", async () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const config = {
      api_host: window.location.origin,
      persistence: "memory" as const,
      advanced_disable_flags: true,
      disable_session_recording: true,
      capture_pageview: false,
      autocapture: false,
    };
    const { PostHog } = await import("posthog-js");
    const posthog = new PostHog();
    posthog.init("phc_consent_reload_test", { ...options, ...config });
    setAnalyticsConsent(posthog, "granted");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    setAnalyticsConsent(posthog, "denied");

    // A reload drops this page's in-memory refusal.
    vi.resetModules();
    const reloaded = await import("../analytics-consent");
    const { options: reloadedOptions } = await import("../PosthogUtils");
    const { PostHog: ReloadedPostHog } = await import("posthog-js");
    const next = new ReloadedPostHog();
    next.init("phc_consent_reload_test", { ...reloadedOptions, ...config });

    expect(reloaded.getAnalyticsConsent()).toBeNull();
    expect(next.is_capturing()).toBe(false);
    expect(next.capture("after_reload")).toBeUndefined();
  });

  it("stops capture when another tab clears a grant a visitor must give", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    const posthog = client();
    setAnalyticsConsent(posthog, "granted");
    followAnalyticsConsentAcrossTabs(posthog);

    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(getAnalyticsConsent()).toBeNull();
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  it("resumes capture when another tab clears a refusal where the server would not ask", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
    const posthog = client();
    setAnalyticsConsent(posthog, "denied");
    followAnalyticsConsentAcrossTabs(posthog);

    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(getAnalyticsConsent()).toBeNull();
    expect(hasAnalyticsConsent()).toBe(true);
    expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("applies a withdrawal made in another tab", () => {
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
    const posthog = {
      ...client(),
      sessionRecording: { startIfEnabledOrStop: vi.fn() },
    };
    setAnalyticsConsent(posthog, "granted");
    followAnalyticsConsentAcrossTabs(posthog);

    window.localStorage.setItem("mcpjam-analytics-consent", "denied");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "mcpjam-analytics-consent",
        newValue: "denied",
      }),
    );

    expect(getAnalyticsConsent()).toBe("denied");
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.sessionRecording.startIfEnabledOrStop).toHaveBeenCalledTimes(
      1,
    );
  });
});
