import { afterEach, expect, it, vi } from "vitest";
import { setAnalyticsConsent } from "../analytics-consent";
import { options } from "../PosthogUtils";
import { posthogPrivacyConfig } from "../session-privacy/posthog-replay";

afterEach(() => {
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function initPostHog(token: string) {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  // Starts this page with no consent, as a visitor who has not answered.
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const { PostHog } = await import("posthog-js");
  const posthog = new PostHog();
  posthog.init(token, {
    ...options,
    api_host: window.location.origin,
    persistence: "memory",
    advanced_disable_flags: true,
    disable_session_recording: true,
    capture_pageview: false,
    autocapture: false,
  });
  return posthog;
}

// What posthog-js's dead-click observer captures, seconds after the click.
function deadClick(clickedAt: number) {
  return { $dead_click_event_timestamp: clickedAt, $el_text: "Inert" };
}

it("keeps the dead-click observer off until the visitor allows analytics", async () => {
  const posthog = await initPostHog("phc_dead_click_observer_test");
  expect(posthogPrivacyConfig("full").capture_dead_clicks).toBe(false);

  setAnalyticsConsent(posthog, "granted");

  expect(posthogPrivacyConfig("full").capture_dead_clicks).toBe(true);
});

it("sends no dead click for a click made before Allow", async () => {
  const posthog = await initPostHog("phc_dead_click_allow_test");
  const clickedAt = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(clickedAt + 2_600);

  setAnalyticsConsent(posthog, "granted");

  expect(posthog.capture("$dead_click", deadClick(clickedAt))).toBeUndefined();
  const sent = posthog.capture("$dead_click", deadClick(clickedAt + 2_600));
  expect(sent?.properties.$el_text).toBe("Inert");
});

it("drops a dead click pending when consent is withdrawn", async () => {
  const posthog = await initPostHog("phc_dead_click_withdraw_test");
  setAnalyticsConsent(posthog, "granted");
  const clickedAt = Date.now();

  setAnalyticsConsent(posthog, "denied");
  vi.spyOn(Date, "now").mockReturnValue(clickedAt + 1_000);
  setAnalyticsConsent(posthog, "granted");

  expect(posthog.capture("$dead_click", deadClick(clickedAt))).toBeUndefined();
});
