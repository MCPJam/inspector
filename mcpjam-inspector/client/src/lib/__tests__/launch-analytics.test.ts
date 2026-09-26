import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  optedOut: vi.fn(),
  disabled: false,
}));
vi.mock("../analytics", () => ({ track: mocks.track }));
vi.mock("posthog-js", () => ({
  default: { has_opted_out_capturing: mocks.optedOut },
}));
vi.mock("../PosthogUtils", () => ({
  get isPostHogDisabled() {
    return mocks.disabled;
  },
}));
import { trackLaunchEngagement } from "../launch-analytics";
const event = {
  launch_id: "platform-launch-2026-09",
  action: "opened",
  feature: "swarms",
  presentation: "card",
  prior_status: "unseen",
  audience: "guest",
} as const;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.disabled = false;
  mocks.optedOut.mockReturnValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("launch analytics", () => {
  it("sends matching correlation IDs to PostHog and the anonymous Axiom endpoint", () => {
    trackLaunchEngagement(event);
    const captured = mocks.track.mock.calls[0];
    expect(captured[0]).toBe("platform_launch_engagement");
    expect(captured[1]).toMatchObject({
      ...event,
      location: "platform_launch",
      event_id: expect.any(String),
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/tlm/launch-engagement");
    expect(init).toMatchObject({ keepalive: true, credentials: "omit" });
    expect(JSON.parse(init!.body as string)).toEqual({
      ...event,
      event_id: captured[1].event_id,
    });
  });
  it.each(["optedOut", "disabled"])(
    "does not send either event when %s",
    (reason) => {
      if (reason === "optedOut") mocks.optedOut.mockReturnValue(true);
      else mocks.disabled = true;
      trackLaunchEngagement(event);
      expect(mocks.track).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("absorbs synchronous and async transport failures", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    expect(() => trackLaunchEngagement(event)).not.toThrow();
    await Promise.resolve();
    vi.mocked(fetch).mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    expect(() => trackLaunchEngagement(event)).not.toThrow();
  });
});
