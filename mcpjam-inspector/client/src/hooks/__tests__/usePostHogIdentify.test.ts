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
    user: null as {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
    } | null,
  },
  convexAuth: {
    isAuthenticated: false,
  },
  convexUser: null as { occupation?: string } | null,
  actorKey: null as string | null,
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
  useQuery: () => mockState.convexUser,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectPlatform: mockState.detectPlatform,
}));

vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => mockState.actorKey,
}));

describe("usePostHogIdentify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__APP_VERSION__", "2.0.13-test");
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;
    mockState.convexUser = null;
    mockState.actorKey = null;
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
    mockState.actorKey = "user_123";

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

  it("identifies guests with their guestId and does not call reset", () => {
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;
    mockState.actorKey = "guest_abc";

    renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {});
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      user_id: "guest_abc",
    });
    expect(mockState.posthog.reset).not.toHaveBeenCalled();
  });

  it("does nothing while the actor key is still resolving", () => {
    mockState.auth.user = null;
    mockState.actorKey = null;

    renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).not.toHaveBeenCalled();
    expect(mockState.posthog.register).not.toHaveBeenCalled();
    expect(mockState.posthog.reset).not.toHaveBeenCalled();
  });

  it("is idempotent across re-renders with the same guest actor key", () => {
    mockState.auth.user = null;
    mockState.actorKey = "guest_abc";

    const { rerender } = renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledTimes(1);
    expect(mockState.posthog.register).toHaveBeenCalledTimes(1);

    rerender();
    rerender();

    expect(mockState.posthog.identify).toHaveBeenCalledTimes(1);
    expect(mockState.posthog.register).toHaveBeenCalledTimes(1);
    expect(mockState.posthog.reset).not.toHaveBeenCalled();
  });

  it("resets and re-registers static telemetry properties when an authed user signs out into a guest session", () => {
    mockState.auth.user = {
      id: "user_123",
      email: "user@example.com",
      firstName: "Taylor",
      lastName: "Smith",
    };
    mockState.convexAuth.isAuthenticated = true;
    mockState.actorKey = "user_123";

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
    mockState.actorKey = "guest_abc";

    rerender();

    expect(mockState.posthog.reset).toHaveBeenCalledTimes(1);
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      environment: import.meta.env.MODE,
      platform: "mac",
      version: "2.0.13-test",
    });
    expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {});
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      user_id: "guest_abc",
    });
  });

  it("aliases a guest into an authed user without calling reset on guest→authed promotion", () => {
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;
    mockState.actorKey = "guest_abc";

    const { rerender } = renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {});

    vi.clearAllMocks();

    mockState.auth.user = {
      id: "user_123",
      email: "user@example.com",
      firstName: "Taylor",
      lastName: "Smith",
    };
    mockState.convexAuth.isAuthenticated = true;
    mockState.actorKey = "user_123";

    rerender();

    expect(mockState.posthog.reset).not.toHaveBeenCalled();
    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Taylor Smith",
      first_name: "Taylor",
      last_name: "Smith",
    });
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      user_id: "user_123",
    });
  });

  it("adds trimmed occupation when the Convex user has one", () => {
    mockState.auth.user = {
      id: "user_123",
      email: "user@example.com",
      firstName: "Taylor",
      lastName: "Smith",
    };
    mockState.convexAuth.isAuthenticated = true;
    mockState.actorKey = "user_123";
    mockState.convexUser = { occupation: "  Platform Engineer  " };

    renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Taylor Smith",
      first_name: "Taylor",
      last_name: "Smith",
      occupation: "Platform Engineer",
    });
  });

  it("omits whitespace-only occupation", () => {
    mockState.auth.user = {
      id: "user_123",
      email: "user@example.com",
      firstName: "Taylor",
      lastName: "Smith",
    };
    mockState.convexAuth.isAuthenticated = true;
    mockState.actorKey = "user_123";
    mockState.convexUser = { occupation: "   " };

    renderHook(() => usePostHogIdentify());

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Taylor Smith",
      first_name: "Taylor",
      last_name: "Smith",
    });
  });
});
