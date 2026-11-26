import { afterEach, expect, it, vi } from "vitest";
import { setAnalyticsConsent } from "../analytics-consent";
import { options } from "../PosthogUtils";
import { setSessionPrivacy, syncSessionRecording } from "../session-privacy";
import { setTelemetryTransportPolicyReader } from "../telemetry-transport-policy";

afterEach(() => {
  setTelemetryTransportPolicyReader(() => "strict");
  setSessionPrivacy("pending");
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.unstubAllGlobals();
});

function click(x: number, y: number) {
  document.body.dispatchEvent(
    new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }),
  );
}

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
    disable_compression: true,
    request_batching: false,
    capture_pageview: false,
    autocapture: false,
  });
  // A signed-in workspace with full telemetry gets the full profile.
  setTelemetryTransportPolicyReader(() => "full");
  setSessionPrivacy("full");
  syncSessionRecording(posthog, "/servers");
  return posthog;
}

async function sentHeatmaps(): Promise<string> {
  window.dispatchEvent(new Event("beforeunload"));
  await vi.waitFor(() =>
    expect(bodies.some((body) => body.includes("$$heatmap"))).toBe(true),
  );
  return bodies.filter((body) => body.includes("$$heatmap")).join();
}

it("sends no heatmap point for a click made before Allow", async () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  const posthog = await initPostHog("phc_heatmap_allow_test");

  click(321, 421);
  setAnalyticsConsent(posthog, "granted");
  click(654, 987);

  const heatmaps = await sentHeatmaps();
  expect(heatmaps).toContain('"x":654');
  expect(heatmaps).not.toContain('"x":321');
});

it("drops heatmap points held when consent is withdrawn", async () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  window.localStorage.setItem("mcpjam-analytics-consent", "granted");
  const posthog = await initPostHog("phc_heatmap_withdraw_test");

  click(123, 456);
  setAnalyticsConsent(posthog, "denied");
  setAnalyticsConsent(posthog, "granted");
  click(654, 987);

  const heatmaps = await sentHeatmaps();
  expect(heatmaps).toContain('"x":654');
  expect(heatmaps).not.toContain('"x":123');
});
