import { afterEach, describe, expect, it, vi } from "vitest";

const { captureMock, getPropertyMock, standardEventPropsMock } = vi.hoisted(
  () => ({
    captureMock: vi.fn(),
    getPropertyMock: vi.fn(),
    standardEventPropsMock: vi.fn((location: string) => ({
      location,
      platform: "web",
      environment: "test",
    })),
  }),
);
vi.mock("posthog-js", () => ({
  default: { capture: captureMock, get_property: getPropertyMock },
}));
vi.mock("../PosthogUtils", () => ({
  standardEventProps: standardEventPropsMock,
}));

import { track } from "../analytics";

describe("track()", () => {
  afterEach(() => {
    captureMock.mockClear();
    getPropertyMock.mockReset();
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

  it("keeps the registered organization id only as the billing group", () => {
    getPropertyMock.mockReturnValue("org_valid");
    track("billing_flow_started", {
      location: "billing_page",
      organization_id: "org_raw",
    });

    expect(captureMock).toHaveBeenCalledWith(
      "billing_flow_started",
      expect.objectContaining({
        organization_id: null,
        $groups: {
          organization: "org_valid",
        },
      }),
    );
  });

  it("groups plan-confirmation events without copying the org into properties", () => {
    getPropertyMock.mockReturnValue("org_registered");
    track("plans_upgrade_confirm_shown", {
      location: "org_plans",
      organization_id: "org_current",
      target_plan: "pro",
    });

    expect(captureMock).toHaveBeenCalledWith(
      "plans_upgrade_confirm_shown",
      expect.objectContaining({
        organization_id: null,
        target_plan: "pro",
        $groups: { organization: "org_current" },
      }),
    );
  });

  it("does not fall back to a registered active org for group-only events", () => {
    getPropertyMock.mockReturnValue("org_registered_but_not_authoritative");
    track("billing_flow_started", {
      location: "billing_page",
      flow: "plan_change",
    });

    expect(captureMock).toHaveBeenCalledWith(
      "billing_flow_started",
      expect.not.objectContaining({ $groups: expect.anything() }),
    );
  });

  it("drops sensitive billing properties at the capture boundary", () => {
    getPropertyMock.mockReturnValue("org_valid");
    track("billing_flow_failed", {
      location: "billing_page",
      flow: "plan_change",
      failure_kind: "request_failed",
      organization_id: "org_raw",
      price_cents: 2900,
      package_id: "pkg_secret",
      error_name: "CardError",
      stripe_customer_id: "cus_secret",
    });

    const properties = captureMock.mock.calls[0][1];
    expect(properties).toMatchObject({
      organization_id: null,
      flow: "plan_change",
      failure_kind: "request_failed",
      $groups: { organization: "org_valid" },
    });
    expect(properties).not.toHaveProperty("price_cents");
    expect(properties).not.toHaveProperty("package_id");
    expect(properties).not.toHaveProperty("error_name");
    expect(properties).not.toHaveProperty("stripe_customer_id");
  });

  it("does not change organization context for unrelated events", () => {
    track("skill_viewed", { location: "skills_tab", skill_name: "x" });

    expect(captureMock.mock.calls[0][1]).not.toHaveProperty("organization_id");
  });

  it("never lets a capture failure break the product action", () => {
    const error = new Error("analytics unavailable");
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureMock.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      track("skill_viewed", { location: "skills_tab", skill_name: "x" }),
    ).not.toThrow();
    expect(warnMock).toHaveBeenCalledWith(
      "[analytics] Failed to capture skill_viewed",
      error,
    );
  });

  it("reports a standard-property failure without breaking the product action", () => {
    const error = new Error("event context unavailable");
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    standardEventPropsMock.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      track("skill_viewed", { location: "skills_tab", skill_name: "x" }),
    ).not.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      "[analytics] Failed to capture skill_viewed",
      error,
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
