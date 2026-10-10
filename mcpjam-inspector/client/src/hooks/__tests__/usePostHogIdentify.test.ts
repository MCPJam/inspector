import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePostHogIdentify } from "../usePostHogIdentify";

const mockState = vi.hoisted(() => ({
  posthog: {
    identify: vi.fn(),
    register: vi.fn(),
    reset: vi.fn(),
    setPersonPropertiesForFlags: vi.fn(),
    unsetPersonProperties: vi.fn(),
    updateFlags: vi.fn(),
  },
  enterprisePrivacyMember: false as boolean | undefined,
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
  refreshServerFeatureFlagsForActor: vi.fn(async () => undefined),
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

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/server-feature-flags", () => ({
  refreshServerFeatureFlagsForActor:
    mockState.refreshServerFeatureFlagsForActor,
}));

vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => mockState.actorKey,
}));

/** Reads membership on every render, so a test can flip it between renders. */
const identify = () =>
  usePostHogIdentify({
    enterprisePrivacyMember: mockState.enterprisePrivacyMember,
  });

describe("usePostHogIdentify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__APP_VERSION__", "2.0.13-test");
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;
    mockState.convexUser = null;
    mockState.actorKey = null;
    mockState.enterprisePrivacyMember = false;
    mockState.detectPlatform.mockReturnValue("mac");
  });

  it("fetches server-evaluated flags once per new actor", () => {
    mockState.auth.user = { id: "user_123", email: "user@example.com" };
    mockState.convexAuth.isAuthenticated = true;
    mockState.actorKey = "user_123";

    const { rerender } = renderHook(identify);
    rerender();

    expect(mockState.refreshServerFeatureFlagsForActor).toHaveBeenCalledTimes(
      1,
    );
    expect(mockState.refreshServerFeatureFlagsForActor).toHaveBeenCalledWith(
      mockState.posthog,
      expect.objectContaining({ actorKey: "user_123", isAuthedActor: true }),
    );
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

    renderHook(identify);

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      deployment: "self_hosted",
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

    renderHook(identify);

    expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {
      // Set for EVERY actor, guests included, so a "self_hosted" flag cohort
      // evaluates before sign-in too.
      deployment: "self_hosted",
    });
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      user_id: "guest_abc",
    });
    expect(mockState.posthog.reset).not.toHaveBeenCalled();
  });

  it("keeps bootstrapped flags on the first identification", () => {
    mockState.auth.user = null;
    mockState.actorKey = "guest_abc";

    renderHook(identify);

    expect(mockState.posthog.updateFlags).not.toHaveBeenCalled();
  });

  it("does nothing while the actor key is still resolving", () => {
    mockState.auth.user = null;
    mockState.actorKey = null;

    renderHook(identify);

    expect(mockState.posthog.identify).not.toHaveBeenCalled();
    expect(mockState.posthog.register).not.toHaveBeenCalled();
    expect(mockState.posthog.reset).not.toHaveBeenCalled();
  });

  it("is idempotent across re-renders with the same guest actor key", () => {
    mockState.auth.user = null;
    mockState.actorKey = "guest_abc";

    const { rerender } = renderHook(identify);

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

    const { rerender } = renderHook(identify);

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      deployment: "self_hosted",
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
      deployment: "self_hosted",
      source: "client",
    });
    expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {
      // Set for EVERY actor, guests included, so a "self_hosted" flag cohort
      // evaluates before sign-in too.
      deployment: "self_hosted",
    });
    expect(mockState.posthog.register).toHaveBeenCalledWith({
      user_id: "guest_abc",
    });
    // `reset()` clears flag person properties too, so they must be restored —
    // otherwise every flag evaluated before the next page load targets an
    // unknown deployment.
    expect(mockState.posthog.setPersonPropertiesForFlags).toHaveBeenCalledWith({
      local_browser_security_version: "1",
      deployment: "self_hosted",
      platform: "mac",
    });
    // reset() already dropped the departing authed actor's flags.
    expect(mockState.posthog.updateFlags).not.toHaveBeenCalled();
  });

  it("aliases a guest into an authed user without calling reset on guest→authed promotion", () => {
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = false;
    mockState.actorKey = "guest_abc";

    const { rerender } = renderHook(identify);

    expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {
      // Set for EVERY actor, guests included, so a "self_hosted" flag cohort
      // evaluates before sign-in too.
      deployment: "self_hosted",
    });

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
    // Without a reset, the guest's server-evaluated flags would survive a
    // failed refresh for the new actor — they are cleared explicitly instead.
    expect(mockState.posthog.updateFlags).toHaveBeenCalledWith({});
    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      deployment: "self_hosted",
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

    renderHook(identify);

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      deployment: "self_hosted",
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

    renderHook(identify);

    expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
      deployment: "self_hosted",
      email: "user@example.com",
      name: "Taylor Smith",
      first_name: "Taylor",
      last_name: "Smith",
    });
  });

  describe("members of an organization with enterprise privacy", () => {
    beforeEach(() => {
      mockState.auth.user = {
        id: "user_123",
        email: "user@example.com",
        firstName: "Taylor",
        lastName: "Smith",
      };
      mockState.convexAuth.isAuthenticated = true;
      mockState.actorKey = "user_123";
      mockState.convexUser = { occupation: "Platform Engineer" };
    });

    it("identifies by id alone until the organizations have loaded, then sends the rest", () => {
      mockState.enterprisePrivacyMember = undefined;

      const { rerender } = renderHook(identify);

      expect(mockState.posthog.identify).toHaveBeenCalledTimes(1);
      expect(mockState.posthog.identify).toHaveBeenLastCalledWith("user_123", {
        deployment: "self_hosted",
      });
      // Attribution does not wait on the organization list.
      expect(mockState.posthog.register).toHaveBeenCalledWith({
        user_id: "user_123",
      });

      mockState.enterprisePrivacyMember = false;
      rerender();

      expect(mockState.posthog.identify).toHaveBeenLastCalledWith("user_123", {
        deployment: "self_hosted",
        email: "user@example.com",
        name: "Taylor Smith",
        first_name: "Taylor",
        last_name: "Smith",
        occupation: "Platform Engineer",
      });
      expect(mockState.posthog.unsetPersonProperties).not.toHaveBeenCalled();
    });

    it("never sends name, email or occupation for a member", () => {
      mockState.enterprisePrivacyMember = undefined;

      const { rerender } = renderHook(identify);
      mockState.enterprisePrivacyMember = true;
      rerender();

      for (const [, properties] of mockState.posthog.identify.mock.calls) {
        expect(properties).toEqual({ deployment: "self_hosted" });
      }
    });

    it("clears identity sent before enterprise privacy was on, once per actor", () => {
      mockState.enterprisePrivacyMember = true;

      const { rerender } = renderHook(identify);
      rerender();
      rerender();

      expect(mockState.posthog.unsetPersonProperties).toHaveBeenCalledTimes(1);
      expect(mockState.posthog.unsetPersonProperties).toHaveBeenCalledWith([
        "email",
        "name",
        "first_name",
        "last_name",
        "occupation",
      ]);
      // After identify, so a first-time merge has landed on the real person.
      expect(
        mockState.posthog.identify.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockState.posthog.unsetPersonProperties.mock.invocationCallOrder[0],
      );
    });

    it("clears again when identity was re-sent in between", () => {
      // member → not a member (identity sent) → member again, in one load.
      mockState.enterprisePrivacyMember = true;
      const { rerender } = renderHook(identify);
      expect(mockState.posthog.unsetPersonProperties).toHaveBeenCalledTimes(1);

      mockState.enterprisePrivacyMember = false;
      rerender();
      expect(mockState.posthog.identify).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ email: expect.any(String) }),
      );

      mockState.enterprisePrivacyMember = true;
      rerender();
      expect(mockState.posthog.unsetPersonProperties).toHaveBeenCalledTimes(2);
    });

    it("leaves guests alone: they carry no identity to clear", () => {
      mockState.auth.user = null;
      mockState.convexAuth.isAuthenticated = false;
      mockState.actorKey = "guest_abc";
      mockState.enterprisePrivacyMember = true;

      renderHook(identify);

      expect(mockState.posthog.identify).toHaveBeenCalledWith("guest_abc", {
        deployment: "self_hosted",
      });
      expect(mockState.posthog.unsetPersonProperties).not.toHaveBeenCalled();
    });

    it("does not throw against a posthog-js without unsetPersonProperties", () => {
      mockState.enterprisePrivacyMember = true;
      const { unsetPersonProperties } = mockState.posthog;
      // A partial stand-in, or a host pinning an older posthog-js.
      Reflect.deleteProperty(mockState.posthog, "unsetPersonProperties");

      try {
        expect(() => renderHook(identify)).not.toThrow();
        expect(mockState.posthog.identify).toHaveBeenCalledWith("user_123", {
          deployment: "self_hosted",
        });
      } finally {
        mockState.posthog.unsetPersonProperties = unsetPersonProperties;
      }
    });
  });
});
