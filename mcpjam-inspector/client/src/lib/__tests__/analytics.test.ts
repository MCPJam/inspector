import { afterEach, describe, expect, it, vi } from "vitest";

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { capture: captureMock } }));
vi.mock("../PosthogUtils", () => ({
  standardEventProps: (location: string) => ({
    location,
    platform: "web",
    environment: "test",
  }),
}));

import { track } from "../analytics";

describe("track()", () => {
  afterEach(() => captureMock.mockClear());

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
});
