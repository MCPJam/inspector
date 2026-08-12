import { afterEach, describe, expect, it, vi } from "vitest";

const { captureMock, standardEventPropsMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  standardEventPropsMock: vi.fn((location: string) => ({
    location,
    platform: "web",
    environment: "test",
  })),
}));
vi.mock("posthog-js", () => ({ default: { capture: captureMock } }));
vi.mock("../PosthogUtils", () => ({
  standardEventProps: standardEventPropsMock,
}));

import { track } from "../analytics";

describe("track()", () => {
  afterEach(() => {
    captureMock.mockClear();
    standardEventPropsMock.mockClear();
    vi.restoreAllMocks();
  });

  it("injects standard props from the location argument", () => {
    track("skill_viewed", { location: "skills_tab", skill_name: "x" });
    expect(captureMock).toHaveBeenCalledWith("skill_viewed", {
      location: "skills_tab",
      platform: "web",
      environment: "test",
      skill_name: "x",
    });
  });

  it("does not let callers override the authoritative standard props", () => {
    track("skill_viewed", {
      location: "skills_tab",
      platform: "spoofed",
      environment: "spoofed",
    } as Record<string, unknown> & { location: string });
    const props = captureMock.mock.calls[0][1];
    expect(props.platform).toBe("web");
    expect(props.environment).toBe("test");
    expect(props.location).toBe("skills_tab");
  });

  it("never lets a capture failure break the product action", () => {
    const error = new Error("analytics unavailable");
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureMock.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      track("skill_viewed", { location: "skills_tab", skill_name: "x" })
    ).not.toThrow();
    expect(warnMock).toHaveBeenCalledWith(
      "[analytics] Failed to capture skill_viewed",
      error
    );
  });

  it("reports a standard-property failure without breaking the product action", () => {
    const error = new Error("event context unavailable");
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    standardEventPropsMock.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      track("skill_viewed", { location: "skills_tab", skill_name: "x" })
    ).not.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      "[analytics] Failed to capture skill_viewed",
      error
    );
  });

  it("strips a caller-supplied environment so it can't survive when standardEventProps omits it", async () => {
    // Regression for the self-hosted/dev case: standardEventProps() omits
    // `environment` when VITE_ENVIRONMENT is unset, so a caller-supplied
    // value must be dropped explicitly — an omitted key on the later spread
    // can't override anything already present from the caller's props.
    vi.resetModules();
    vi.doMock("../PosthogUtils", () => ({
      standardEventProps: (location: string) => ({
        location,
        platform: "web",
      }),
    }));
    const { track: trackWithOmittedEnv } = await import("../analytics");

    trackWithOmittedEnv("skill_viewed", {
      location: "skills_tab",
      environment: "should-not-survive",
    } as Record<string, unknown> & { location: string });

    const props = captureMock.mock.calls[0][1];
    expect(props).not.toHaveProperty("environment");

    vi.doUnmock("../PosthogUtils");
    vi.resetModules();
  });
});
