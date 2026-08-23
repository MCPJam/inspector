import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEnsureDbUser } from "../useEnsureDbUser";

const mockState = vi.hoisted(() => ({
  actorKey: "guest-1" as string | null,
  auth: {
    user: null as {
      id: string;
      email?: string;
      firstName?: string | null;
      lastName?: string | null;
    } | null,
  },
  convexAuth: {
    isAuthenticated: true,
    isLoading: false,
  },
  ensureUser: vi.fn().mockResolvedValue(undefined),
  getGuestPromotionProof: vi.fn().mockResolvedValue(null),
  revokeGuestSessionAndCookie: vi.fn().mockResolvedValue(false),
  getExistingGuestId: vi.fn().mockResolvedValue(null as string | null),
  isGuestActivated: vi.fn().mockReturnValue(false),
  sentrySetUser: vi.fn(),
  sentrySetTag: vi.fn(),
  posthog: null as {
    get_property?: (key: string) => unknown;
    get_distinct_id?: () => string;
  } | null,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
  useMutation: () => mockState.ensureUser,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => mockState.posthog,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.auth,
}));

vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => mockState.actorKey,
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestPromotionProof: mockState.getGuestPromotionProof,
  revokeGuestSessionAndCookie: mockState.revokeGuestSessionAndCookie,
  getExistingGuestId: mockState.getExistingGuestId,
  isGuestActivated: mockState.isGuestActivated,
}));

// `@/lib/sentry-identity` is deliberately NOT mocked: it is the module under
// test as much as the hook is, so these assertions run against the real
// mapping from actor to Sentry scope rather than a restatement of it.
vi.mock("@sentry/react", () => ({
  setUser: mockState.sentrySetUser,
  setTag: mockState.sentrySetTag,
}));

describe("useEnsureDbUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.ensureUser.mockResolvedValue(undefined);
    mockState.getGuestPromotionProof.mockResolvedValue(null);
    mockState.revokeGuestSessionAndCookie.mockResolvedValue(false);
    mockState.getExistingGuestId.mockResolvedValue(null);
    mockState.isGuestActivated.mockReturnValue(false);
    mockState.actorKey = "guest-1";
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
    mockState.posthog = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the user as ready only after ensureUser succeeds", async () => {
    let resolveEnsureUser: (() => void) | undefined;
    mockState.ensureUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsureUser = resolve;
        })
    );

    const { result } = renderHook(() => useEnsureDbUser());

    expect(result.current.isUserReady).toBe(false);
    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });
    expect(result.current.isUserReady).toBe(false);

    await act(async () => {
      resolveEnsureUser?.();
    });

    await waitFor(() => {
      expect(result.current.isUserReady).toBe(true);
    });
  });

  it("re-runs ensureUser when the guest actor key rotates", async () => {
    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    mockState.actorKey = "guest-2";
    rerender();

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
    });
  });

  it("waits for a guest actor key before ensuring the guest row", async () => {
    mockState.actorKey = null;
    const { rerender } = renderHook(() => useEnsureDbUser());

    expect(mockState.ensureUser).not.toHaveBeenCalled();

    mockState.actorKey = "guest-1";
    rerender();

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });
  });

  it("identifies a signed-in user by email so Sentry issues name a person", async () => {
    mockState.auth.user = {
      id: "workos-user-1",
      email: "someone@example.com",
      firstName: "Some",
      lastName: "One",
    };
    mockState.actorKey = "workos-user-1";
    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith({
        id: "workos-user-1",
        email: "someone@example.com",
        username: "someone@example.com",
        name: "Some One",
      });
    });
    expect(mockState.sentrySetTag).toHaveBeenCalledWith(
      "actor_kind",
      "signedIn"
    );
  });

  it.each([
    ["only a first name", { firstName: "Some", lastName: null }, "Some"],
    ["only a last name", { firstName: null, lastName: "One" }, "One"],
    ["a whitespace-only half", { firstName: "Some", lastName: "  " }, "Some"],
  ])("builds the display name from %s", async (_label, names, expected) => {
    mockState.auth.user = { id: "workos-user-1", ...names };
    mockState.actorKey = "workos-user-1";
    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith(
        expect.objectContaining({ name: expected })
      );
    });
  });

  it.each([
    ["both halves are null", { firstName: null, lastName: null }],
    ["both halves are empty", { firstName: "", lastName: "" }],
    ["AuthKit supplies neither", {}],
  ])("omits the name key entirely when %s", async (_label, names) => {
    // Omitted rather than empty: Sentry renders a user block from whatever
    // keys are present, and `name: ""` shows as a blank line where the email
    // would otherwise be.
    mockState.auth.user = {
      id: "workos-user-1",
      email: "someone@example.com",
      ...names,
    };
    mockState.actorKey = "workos-user-1";
    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith({
        id: "workos-user-1",
        email: "someone@example.com",
        username: "someone@example.com",
      });
    });
  });

  it("identifies the actor before ensureUser resolves", async () => {
    // The regression this pins: identity used to be set only after the
    // ensureUser round-trip, so anything that crashed during boot — or on a
    // session whose ensureUser never succeeded — reported anonymously.
    mockState.ensureUser.mockImplementation(() => new Promise<void>(() => {}));
    mockState.auth.user = { id: "workos-user-1", email: "someone@example.com" };
    mockState.actorKey = "workos-user-1";

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: "someone@example.com" })
      );
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
  });

  it("identifies guests on the same key PostHog uses", async () => {
    mockState.auth.user = null;
    mockState.actorKey = "guest-1";
    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith({ id: "guest-1" });
    });
    expect(mockState.sentrySetTag).toHaveBeenCalledWith("actor_kind", "guest");
  });

  it("drops the signed-in identity when WorkOS signs out but Convex remains guest-authenticated", async () => {
    mockState.auth.user = { id: "workos-user-1", email: "someone@example.com" };
    mockState.actorKey = "workos-user-1";
    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith(
        expect.objectContaining({ id: "workos-user-1" })
      );
    });

    mockState.sentrySetUser.mockClear();
    mockState.auth.user = null;
    mockState.actorKey = "guest-1";
    rerender();

    // The guest is identified rather than blanked, but the previous account's
    // email must not survive the switch — `setUser` replaces wholesale, and
    // this asserts the replacement rather than trusting it.
    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith({ id: "guest-1" });
    });
    expect(mockState.sentrySetUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: "someone@example.com" })
    );
  });

  it("clears the scope entirely while the actor is still resolving", async () => {
    mockState.auth.user = null;
    mockState.actorKey = null;
    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith(null);
    });
  });

  it("does not re-run when AuthKit returns a new user object for the same id", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    mockState.auth.user = { id: "workos-user-1" };
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight ensureUser call for the same identity", async () => {
    let resolveEnsureUser: (() => void) | undefined;
    mockState.ensureUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsureUser = resolve;
        })
    );

    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    const nextEnsureUser = vi.fn().mockResolvedValue(undefined);
    mockState.ensureUser = nextEnsureUser;
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(nextEnsureUser).not.toHaveBeenCalled();

    await act(async () => {
      resolveEnsureUser?.();
    });
  });

  it("retries ensureUser on Convex write conflicts", async () => {
    mockState.ensureUser
      .mockRejectedValueOnce(
        new Error(
          'Documents read from or written to the "users" table changed while this mutation was being run'
        )
      )
      .mockResolvedValueOnce(undefined);

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
    });
  });

  it("abandons a pending retry when the identity changes", async () => {
    vi.useFakeTimers();
    mockState.ensureUser
      .mockRejectedValueOnce(
        new Error(
          'Documents read from or written to the "users" table changed while this mutation was being run'
        )
      )
      .mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useEnsureDbUser());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);

    mockState.actorKey = "guest-2";
    rerender();

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
  });

  it("revokes an incidental (unactivated) guest cookie on WorkOS auth without promoting", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    // A guest cookie exists (incidental document bootstrap) but was never
    // activated as a guest.
    mockState.getExistingGuestId.mockResolvedValue("guest-incidental");
    mockState.isGuestActivated.mockReturnValue(false);

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    // No promotion proof requested.
    expect(mockState.getGuestPromotionProof).not.toHaveBeenCalled();
    // ensureUser called WITHOUT guestProofJwt.
    expect(mockState.ensureUser).toHaveBeenCalledWith({});
    // Incidental cookie revoked.
    await waitFor(() => {
      expect(mockState.revokeGuestSessionAndCookie).toHaveBeenCalledTimes(1);
    });
  });

  it("promotes an activated guest on WorkOS auth", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.getExistingGuestId.mockResolvedValue("guest-activated");
    mockState.isGuestActivated.mockReturnValue(true);
    mockState.getGuestPromotionProof.mockResolvedValue("proof-jwt");

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.getGuestPromotionProof).toHaveBeenCalledTimes(1);
    });
    // ensureUser called WITH the proof.
    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({
        guestProofJwt: "proof-jwt",
      });
    });
    // Activated guests still revoke their cookie after a successful promote.
    await waitFor(() => {
      expect(mockState.revokeGuestSessionAndCookie).toHaveBeenCalledTimes(1);
    });
  });

  it("does not request a promotion proof or revoke when no guest cookie exists", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.getExistingGuestId.mockResolvedValue(null);

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    expect(mockState.getGuestPromotionProof).not.toHaveBeenCalled();
    expect(mockState.revokeGuestSessionAndCookie).not.toHaveBeenCalled();
    expect(mockState.ensureUser).toHaveBeenCalledWith({});
  });

  it("sends posthogAnonDistinctId ($device_id) for WorkOS auth", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.posthog = {
      get_property: vi.fn((key: string) =>
        key === "$device_id" ? "device-abc" : undefined
      ),
      get_distinct_id: vi.fn(() => "distinct-abc"),
    };

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({
        posthogAnonDistinctId: "device-abc",
      });
    });
  });

  it("falls back to get_distinct_id() when $device_id is unavailable", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.posthog = {
      get_property: vi.fn(() => undefined),
      get_distinct_id: vi.fn(() => "distinct-abc"),
    };

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({
        posthogAnonDistinctId: "distinct-abc",
      });
    });
  });

  it("never sends posthogAnonDistinctId for guest identities", async () => {
    mockState.auth.user = null;
    mockState.actorKey = "guest-1";
    mockState.posthog = {
      get_property: vi.fn(() => "device-abc"),
      get_distinct_id: vi.fn(() => "distinct-abc"),
    };

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });
    expect(mockState.ensureUser).toHaveBeenCalledWith({});
  });

  it("still calls ensureUser when posthog is absent", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.posthog = null;

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({});
    });
  });

  it("still calls ensureUser when posthog getters throw", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.posthog = {
      get_property: vi.fn(() => {
        throw new Error("boom");
      }),
      get_distinct_id: vi.fn(() => {
        throw new Error("boom");
      }),
    };

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({});
    });
  });

  it("still falls back to get_distinct_id() when get_property throws (not just returns undefined)", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.posthog = {
      get_property: vi.fn(() => {
        throw new Error("boom");
      }),
      get_distinct_id: vi.fn(() => "distinct-abc"),
    };

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({
        posthogAnonDistinctId: "distinct-abc",
      });
    });
  });

  it("reports the failure immediately, before any recovery retry", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockState.ensureUser.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[auth] ensureUser failed",
        expect.any(Error)
      );
    });
    expect(result.current.isUserReady).toBe(false);
    // Still "ensuring": App renders "Could not finish setup" as soon as this
    // clears for a user with no row, so a queued retry must keep it set.
    expect(result.current.isEnsuringUser).toBe(true);
  });

  it("keeps setup in progress until the retries are exhausted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    mockState.ensureUser.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useEnsureDbUser());

    await act(async () => {
      await Promise.resolve();
    });

    // Across every gap between attempts, setup still reads as in progress.
    for (const delayMs of [1_000, 5_000, 15_000]) {
      expect(result.current.isEnsuringUser).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delayMs);
      });
    }

    // Budget spent: setup is genuinely finished and failed, so the error
    // screen is now the right thing to show.
    expect(mockState.ensureUser).toHaveBeenCalledTimes(4);
    expect(result.current.isEnsuringUser).toBe(false);
    expect(result.current.isUserReady).toBe(false);
  });

  // A failed run used to be terminal: nothing re-ran the effect, so every
  // readiness-gated query stayed skipped until the user reloaded the tab.
  it("recovers from a non-conflict failure on a spaced retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    mockState.ensureUser
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    const { result } = renderHook(() => useEnsureDbUser());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    expect(result.current.isUserReady).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
    // `waitFor` polls on real timers, which never advance here — flush the
    // retry's own microtasks instead.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isUserReady).toBe(true);
  });

  it("gives up after the spaced retries are exhausted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    mockState.ensureUser.mockRejectedValue(new Error("boom"));

    renderHook(() => useEnsureDbUser());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);

    // 1s, 5s, then 15s — four attempts in total.
    for (const delayMs of [1_000, 5_000, 15_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delayMs);
      });
    }
    expect(mockState.ensureUser).toHaveBeenCalledTimes(4);

    // Budget spent: no further attempt, however long the tab stays open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(4);
  });

  it("drops a pending recovery retry when the identity changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    mockState.ensureUser
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useEnsureDbUser());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);

    // The new identity ensures itself right away; the queued retry for the
    // old one must not fire on top of it.
    mockState.actorKey = "guest-2";
    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
  });
});
