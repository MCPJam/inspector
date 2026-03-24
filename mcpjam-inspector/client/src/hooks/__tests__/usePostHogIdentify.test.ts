import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePostHogIdentify } from "../usePostHogIdentify";

const mockState = vi.hoisted(() => ({
  posthog: {
    identify: vi.fn(),
    register: vi.fn(),
    reset: vi.fn(),
  },
  auth: {
    user: null as
      | {
          id: string;
          email: string;
          firstName?: string | null;
          lastName?: string | null;
        }
      | null,
  },
  convexAuth: {
    isAuthenticated: false,
  },
  detectPlatform: vi.fn(() => "mac"),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => mockState.posthog,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.auth,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectPlatform: mockState.detectPlatform,
}));

describe("usePostHogIdentify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__APP_VERSION__", "2.0.13-test");
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;
    mockState.detectPlatform.mockReturnValue("mac");
  });

  it("identifies authenticated users and registers their user_id", () => {
    mockState.auth.user = {
      id: "user_123",
      email: "user@example.com",
      firstName: "Taylor",
      lastName: "Smith",
    };
    mockState.convexAuth.isAuthenticated = true;

    renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Taylor Smith",
      first_name: "Taylor",
      last_name: "Smith",
    });
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      user_id: "user_123",
    });
    expect(mockState.posthog.reset).not.toHaveBeenCalled();
  });

  it("re-registers static telemetry properties after logout reset", () => {
    renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.reset).toHaveBeenCalledTimes(1);
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      environment: import.meta.env.MODE,
      platform: "mac",
      version: "2.0.13-test",
    });
  });

  it("resets and re-registers static telemetry properties when auth changes from logged in to logged out", () => {
    mockState.auth.user = {
      id: "user_123",
      email: "user@example.com",
      firstName: "Taylor",
      lastName: "Smith",
    };
    mockState.convexAuth.isAuthenticated = true;

    const { rerender } = renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Taylor Smith",
      first_name: "Taylor",
      last_name: "Smith",
    });

    vi.clearAllMocks();

    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;

    rerender();

    expect(mockState.posthog.reset).toHaveBeenCalledTimes(1);
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      environment: import.meta.env.MODE,
      platform: "mac",
      version: "2.0.13-test",
    });
    expect(mockState.posthog.identify).not.toHaveBeenCalled();
  });
});
