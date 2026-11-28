import { afterEach, expect, it, vi } from "vitest";
import { setAnalyticsConsent } from "../analytics-consent";
import { options } from "../PosthogUtils";

afterEach(() => {
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.restoreAllMocks();
});

// posthog-js keeps the `fetch` it first sees, so every test shares one.
const bodies: string[] = [];
const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
  if (typeof init?.body === "string") bodies.push(init.body);
  return new Response("{}");
});

async function initPostHog(token: string) {
  bodies.length = 0;
  vi.stubGlobal("fetch", fetchStub);
  const { PostHog } = await import("posthog-js");
  const posthog = new PostHog();
  posthog.init(token, {
    ...options,
    api_host: window.location.origin,
    persistence: "memory",
    advanced_disable_flags: true,
    disable_session_recording: true,
    disable_compression: true,
    capture_pageview: false,
    autocapture: false,
    request_queue_config: { flush_interval_ms: 250 },
  });
  return posthog;
}

async function delivered(eventName: string): Promise<void> {
  await vi.waitFor(() =>
    expect(bodies.some((body) => body.includes(eventName))).toBe(true),
  );
}

it("sends batched events after another tab clears a refusal where the server would not ask", async () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
  window.localStorage.setItem("mcpjam-analytics-consent", "denied");
  const token = "phc_delivery_clear_test";
  const posthog = await initPostHog(token);

  window.localStorage.removeItem("mcpjam-analytics-consent");
  window.dispatchEvent(
    new StorageEvent("storage", { key: "mcpjam-analytics-consent" }),
  );
  posthog.capture("after_clear_marker");

  await delivered("after_clear_marker");
  // The location's default is not stored as the visitor's choice.
  expect(window.localStorage.getItem(`__ph_opt_in_out_${token}`)).toBeNull();
});

it("sends batched events after a grant storage refused", async () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  const posthog = await initPostHog("phc_delivery_grant_test");
  setAnalyticsConsent(posthog, "denied");

  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  setAnalyticsConsent(posthog, "granted");
  posthog.capture("after_grant_marker");

  await delivered("after_grant_marker");
});
