import { GuestTabRecoveryBoundary } from "@/components/GuestTabRecoveryBoundary";
import { guestTabRecovery } from "../auth/guest-tab-recovery";
import { useEffect } from "react";
import { SignOutBoundary } from "@/components/SignOutBoundary";
import { showSignOutScreen, useSignOutStore } from "@/stores/sign-out-store";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConvexReactClient, useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexProviderWithAuth } from "convex/react";
import { AuthRecoveryBoundary } from "@/components/AuthRecoveryBoundary";
import { installConvexAuthRecovery } from "../convex-auth-recovery";
import * as Sentry from "@sentry/react";
import { reportCaught } from "../error-reporting";
import {
  DbUserReadyProvider,
  useDbUserReady,
} from "@/contexts/db-user-ready-context";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { useUnifiedConvexAuth } from "../unified-convex-auth";

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  user: { id: "test-user" } as { id: string } | null,
  isLoading: false,
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));
const guest = vi.hoisted(() => ({
  cached: null as null | { token: string; guestId: string },
  mint: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/guest-session", () => ({
  getCachedGuestSession: () => guest.cached,
  getOrCreateGuestSessionOrThrow: guest.mint,
  forceRefreshGuestSessionOrThrow: guest.refresh,
  markGuestActivated: vi.fn(),
  getGuestSessionRefusal: () => null,
}));

vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => guest.cached?.guestId ?? null,
}));

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@/components/guest-session-refused-banner", () => ({
  GuestSessionRefusedBanner: () => null,
}));

const names = [
  "hostConfigsV2:getProjectDefault",
  "billing:getOrganizationPremiumness",
  "billing:getProjectPremiumness",
  "billing:getOrganizationBillingStatus",
  "billing:getOrganizationEntitlements",
  "projectServerConfig:getConfig",
  "billing:getPlanCatalog",
  "hosts:getHost",
];
function ProtectedQuery({ name }: { name: string }) {
  const ready = useDbUserReady();
  useQuery(makeFunctionReference<"query">(name), ready ? {} : "skip");
  return null;
}
let databaseReady = true;
const appMounts = vi.fn();
function Shell() {
  const { isAuthenticated } = useConvexAuth();
  // The test actor already has its database row; only auth/readiness changes.
  return (
    <DbUserReadyProvider isUserReady={isAuthenticated && databaseReady}>
      <AuthRecoveryBoundary ready={isAuthenticated && databaseReady}>
        <UngatedQueries />
        {names.map((name) => (
          <ProtectedQuery key={name} name={name} />
        ))}
      </AuthRecoveryBoundary>
    </DbUserReadyProvider>
  );
}

// A protocol peer, not a mock Convex client. It accepts test JWTs and supplies
// successful query results. Inject server AuthError messages; inspect the real
// SDK's outgoing messages, including queries without authenticated identity.
function protocolPeer() {
  const active = new Set<number>();
  const clearCounts: number[] = [];
  let version = { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" };
  let timestamp = 0;
  let lastSocket: Socket;
  const unauthenticatedAdds: number[] = [];
  const messages: string[] = [];
  let hold = false;
  let rejectFresh = false;
  const pending: Array<() => void> = [];
  class Socket {
    readyState = 0;
    onopen?: (event: object) => void;
    onclose?: (event: object) => void;
    onmessage?: (event: { data: string }) => void;
    hasAuth = false;
    constructor() {
      lastSocket = this;
      version = { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" };
      active.clear();
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      messages.push(
        message.type +
          (message.type === "Authenticate" ? ":" + message.tokenType : ""),
      );
      if (message.type === "Authenticate") {
        if (rejectFresh && message.tokenType === "User") {
          queueMicrotask(() =>
            this.onmessage?.({
              data: JSON.stringify({
                type: "AuthError",
                error: "Rejected test token",
                baseVersion: message.baseVersion,
                authUpdateAttempted: true,
              }),
            }),
          );
          return;
        }
        this.hasAuth = message.tokenType !== "None";
        if (message.tokenType === "None") clearCounts.push(active.size);
        this.transition({ ...version, identity: message.baseVersion + 1 }, []);
      }
      if (message.type === "ModifyQuerySet") {
        const updates = [];
        for (const change of message.modifications) {
          if (change.type === "Add") {
            active.add(change.queryId);
            if (!this.hasAuth) unauthenticatedAdds.push(change.queryId);
            updates.push({
              type: "QueryUpdated",
              queryId: change.queryId,
              value: null,
              logLines: [],
              journal: null,
            });
          } else active.delete(change.queryId);
        }
        this.transition({ ...version, querySet: message.newVersion }, updates);
      }
    }
    transition(end: typeof version, modifications: object[]) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, BigInt(++timestamp), true);
      end.ts = btoa(String.fromCharCode(...bytes));
      const message = {
        type: "Transition",
        startVersion: version,
        endVersion: end,
        modifications,
      };
      version = end;
      const deliver = () => this.onmessage?.({ data: JSON.stringify(message) });
      if (hold) pending.push(deliver);
      else queueMicrotask(deliver);
    }
  }
  return {
    active,
    clearCounts,
    rejectFreshTokens: () => {
      rejectFresh = true;
    },
    messages,
    unauthenticatedAdds,
    rejectIdentity: () =>
      lastSocket.onmessage?.({
        data: JSON.stringify({
          type: "AuthError",
          error: "Token rejected by test server",
          baseVersion: version.identity - 1,
          authUpdateAttempted: true,
        }),
      }),
    Socket,
    holdConfirmations: () => {
      hold = true;
    },
    releaseConfirmations: () => {
      hold = false;
      for (const deliver of pending.splice(0)) queueMicrotask(deliver);
    },
    pendingConfirmations: () => pending.length,
  };
}
function jwt(n: number) {
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ iat: 1700000000, exp: 1700000003, n }))}.test`;
}
const pauseQueries = useSessionRefreshStore.getState().pauseQueries;
beforeEach(() => {
  auth.user = { id: "test-user" };
  guest.cached = null;
  vi.resetAllMocks();
  databaseReady = true;
  guest.mint.mockReset();
  guest.refresh.mockReset();
  auth.getAccessToken.mockReset();
  useSignOutStore.setState({ isSigningOut: false });
  useSessionRefreshStore.setState({
    status: "idle",
    kind: null,
    retryNonce: 0,
    queriesPaused: false,
    authConfirmed: false,
    authEpoch: 0,
    recoveryId: null,
    recoveryAt: 0,
    pauseQueries,
  });
});
afterEach(() => useSessionRefreshStore.setState({ pauseQueries }));

function UngatedQueries() {
  useEffect(() => {
    appMounts();
  }, []);
  useQuery(makeFunctionReference<"query">("unguarded:query"), {});
  return <div>App content</div>;
}
function setup(withGuestRecovery = false) {
  const peer = protocolPeer();
  const client = new ConvexReactClient("https://test.convex.cloud", {
    webSocketConstructor: peer.Socket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
    logger: false,
  });
  installConvexAuthRecovery(client);
  const tree = () => (
    <ConvexProviderWithAuth client={client} useAuth={useUnifiedConvexAuth}>
      <SignOutBoundary>
        <AuthRecoveryBoundary>
          {withGuestRecovery ? (
            <GuestTabRecoveryBoundary>
              <Shell />
            </GuestTabRecoveryBoundary>
          ) : (
            <Shell />
          )}
        </AuthRecoveryBoundary>
      </SignOutBoundary>
    </ConvexProviderWithAuth>
  );
  const view = render(tree());
  return {
    peer,
    client,
    view,
    rerender: () => view.rerender(tree()),
    close: async () => {
      view.unmount();
      await client.close();
    },
  };
}

it.each(["same", "fresh", "null", "network"])(
  "server rejection with %s refresh never sends unauthenticated subscriptions",
  async (result) => {
    let rejected = false;
    auth.getAccessToken.mockImplementation(async () => {
      if (!rejected || result === "same") return jwt(1);
      if (result === "network")
        throw new TypeError("secret-token-must-not-be-logged");
      return result === "fresh" ? jwt(2) : null;
    });
    const { peer, view, close } = setup();
    try {
      await waitFor(() => expect(peer.active.size).toBe(9));
      await act(async () => {
        rejected = true;
        peer.rejectIdentity();
      });
      if (result === "fresh") {
        await waitFor(() =>
          expect(view.queryByText("App content")).not.toBeNull(),
        );
        await waitFor(() => expect(peer.active.size).toBe(9));
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          "Convex authentication recovery",
          expect.objectContaining({
            extra: expect.objectContaining({ outcome: "recovered" }),
          }),
        );
      } else {
        await waitFor(
          () => expect(useSessionRefreshStore.getState().status).toBe("failed"),
          { timeout: 10000 },
        );
        expect(peer.active.size).toBe(0);
        expect(view.queryByText("App content")).toBeNull();
        expect(view.queryByText("Retry")).not.toBeNull();
      }
      for (const [error, options] of vi.mocked(reportCaught).mock.calls) {
        expect(String(error)).not.toContain("secret-token-must-not-be-logged");
        expect(JSON.stringify(options)).not.toContain(
          "secret-token-must-not-be-logged",
        );
      }
      expect(peer.unauthenticatedAdds).toEqual([]);
      expect(auth.getAccessToken).toHaveBeenLastCalledWith({
        forceRefresh: true,
      });
    } finally {
      await close();
    }
  },
  15000,
);

it("a rejection during a scheduled refresh recovers with the shared fresh token", async () => {
  // The token provider dedupes concurrent refreshes: every caller waiting on
  // the in-flight refresh gets the same new token.
  let release!: (token: string) => void;
  const inFlight = new Promise<string>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  auth.getAccessToken.mockImplementation(() => {
    calls += 1;
    return calls === 1
      ? Promise.resolve(jwt(1))
      : calls === 2
        ? Promise.resolve(jwt(2))
        : inFlight;
  });
  const { peer, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    // jwt(2) was accepted, so Convex scheduled its next refresh; it is now
    // waiting on the provider when a function's expired auth is refused.
    await waitFor(() => expect(calls).toBe(3));
    await act(async () => peer.rejectIdentity());
    await waitFor(() => expect(calls).toBe(4));
    await act(async () => release(jwt(3)));
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(useSessionRefreshStore.getState().status).toBe("idle");
    expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
    expect(peer.clearCounts).toEqual([]);
    expect(peer.unauthenticatedAdds).toEqual([]);
    expect(reportCaught).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("renews an expiring token when the page comes back, without a rejection", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  const { peer, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().authConfirmed).toBe(true),
    );
    const before = peer.messages.filter(
      (m) => m === "Authenticate:User",
    ).length;
    auth.getAccessToken.mockResolvedValue(jwt(2));
    // jwt(1) expired long ago: the page was away longer than its lifetime.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
    });
    await waitFor(() =>
      expect(
        peer.messages.filter((m) => m === "Authenticate:User").length,
      ).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().authConfirmed).toBe(true),
    );
    expect(peer.active.size).toBe(9);
    expect(appMounts).toHaveBeenCalledTimes(1);
    expect(useSessionRefreshStore.getState().status).toBe("idle");
    expect(peer.unauthenticatedAdds).toEqual([]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("keeps the spinner until replacement confirmation; Retry recovers after an unchanged token", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  const { peer, view, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    await act(async () => peer.rejectIdentity());
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().status).toBe("failed"),
    );
    auth.getAccessToken.mockResolvedValue(jwt(2));
    peer.holdConfirmations();
    act(() => useSessionRefreshStore.getState().retry());
    await waitFor(() => expect(peer.pendingConfirmations()).toBeGreaterThan(0));
    expect(view.queryByText("App content")).toBeNull();
    expect(peer.active.size).toBe(0);
    await act(async () => peer.releaseConfirmations());
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(peer.unauthenticatedAdds).toEqual([]);
  } finally {
    await close();
  }
});

it("guest refresh forces renewal even while the cache still has the rejected token", async () => {
  auth.user = null;
  guest.cached = { token: jwt(1), guestId: "guest-test" };
  guest.mint.mockImplementation(async () => guest.cached);
  guest.refresh.mockImplementation(async () => guest.cached!.token);
  const { peer, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    guest.refresh.mockImplementation(async () => {
      guest.cached = { token: jwt(2), guestId: "guest-test" };
      return jwt(2);
    });
    await act(async () => peer.rejectIdentity());
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(guest.refresh).toHaveBeenCalled();
    expect(peer.unauthenticatedAdds).toEqual([]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        extra: expect.objectContaining({ outcome: "recovered", mode: "guest" }),
      }),
    );
  } finally {
    await close();
  }
});

it.each(["logout", "account", "retry"])(
  "ignores an old refresh result after %s",
  async (transition) => {
    auth.getAccessToken.mockResolvedValue(jwt(1));
    const { peer, view, rerender, close } = setup();
    try {
      await waitFor(() => expect(peer.active.size).toBe(9));
      let finish!: (value: string | null) => void;
      auth.getAccessToken.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await act(async () => peer.rejectIdentity());
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      // A refresh in flight keeps the app (and whatever it has open) mounted.
      expect(view.queryByText("App content")).not.toBeNull();
      if (transition === "logout") act(() => showSignOutScreen());
      else {
        auth.getAccessToken.mockResolvedValue(jwt(3));
        if (transition === "account") {
          auth.user = { id: "other-user" };
          rerender();
        } else act(() => useSessionRefreshStore.getState().retry());
        await waitFor(() => expect(peer.active.size).toBe(9));
      }
      await act(async () => finish(null));
      expect(useSessionRefreshStore.getState().status).not.toBe("failed");
      expect(peer.unauthenticatedAdds).toEqual([]);
      if (transition === "logout")
        expect(view.queryByText("App content")).toBeNull();
      else expect(peer.active.size).toBe(9);
    } finally {
      await close();
    }
  },
);

it("repeated rejection of fresh tokens stays blocked after the SDK gives up", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  const { peer, view, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    let next = 1;
    auth.getAccessToken.mockImplementation(async () => jwt(++next));
    peer.rejectFreshTokens();
    await act(async () => peer.rejectIdentity());
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().status).toBe("failed"),
    );
    expect(peer.active.size).toBe(0);
    // The app stays mounted while the first replacement is tried, so the one
    // restart that carries it re-subscribes with it. Once the server refuses
    // the replacement too, every subscription is cancelled before Convex
    // tries another token, and nothing is subscribed after it gives up.
    expect(peer.unauthenticatedAdds.length).toBeLessThanOrEqual(
      names.length + 1,
    );
    expect(view.queryByText("App content")).toBeNull();
    const episodes = vi
      .mocked(reportCaught)
      .mock.calls.filter(
        ([, options]) => options.source === "convex_auth_recovery",
      );
    expect(episodes).toHaveLength(1);
    expect(episodes[0][1].extra).toMatchObject({
      outcome: "failed",
      mode: "workos",
    });
    const logs = JSON.stringify([
      episodes,
      vi.mocked(Sentry.captureMessage).mock.calls,
    ]);
    expect(logs).not.toContain(jwt(1));
    expect(logs).not.toContain(jwt(2));
    expect(logs).not.toContain("Rejected test token");
  } finally {
    await close();
  }
});

it("normal background refresh does not unmount the app or record a rejection", async () => {
  let calls = 0;
  auth.getAccessToken.mockImplementation(async () =>
    jwt(++calls === 1 ? 1 : 2),
  );
  const { peer, close } = setup();
  try {
    await waitFor(() =>
      expect(auth.getAccessToken.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(appMounts).toHaveBeenCalledTimes(1);
    expect(peer.clearCounts).toEqual([]);
    expect(peer.unauthenticatedAdds).toEqual([]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("a refresh that recovers keeps the app mounted and its subscriptions live", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  const { peer, view, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    let release!: (token: string) => void;
    auth.getAccessToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => peer.rejectIdentity());
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // The auth gap: identity is being replaced, the app is still there.
    expect(view.queryByText("App content")).not.toBeNull();
    expect(useSessionRefreshStore.getState().authConfirmed).toBe(false);
    expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
    const epoch = useSessionRefreshStore.getState().authEpoch;
    await act(async () => release(jwt(2)));
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().authEpoch).toBeGreaterThan(
        epoch,
      ),
    );
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(appMounts).toHaveBeenCalledTimes(1);
    expect(useSessionRefreshStore.getState().status).toBe("idle");
    expect(peer.unauthenticatedAdds).toEqual([]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Convex authentication recovery",
      expect.objectContaining({
        extra: expect.objectContaining({ outcome: "recovered" }),
      }),
    );
  } finally {
    await close();
  }
});

it("after a failed recovery, authentication alone does not resume queries until database readiness", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  const { peer, view, rerender, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    // The provider hands back the rejected token: the recovery fails.
    await act(async () => peer.rejectIdentity());
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().status).toBe("failed"),
    );
    databaseReady = false;
    auth.getAccessToken.mockResolvedValue(jwt(2));
    act(() => useSessionRefreshStore.getState().retry());
    await waitFor(() =>
      expect(useSessionRefreshStore.getState().authConfirmed).toBe(true),
    );
    expect(peer.active.size).toBe(0);
    expect(view.queryByText("App content")).toBeNull();
    databaseReady = true;
    rerender();
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(peer.unauthenticatedAdds).toEqual([]);
  } finally {
    await close();
  }
});

it.each(["success", "failure"])(
  "logging exceptions cannot interrupt %s recovery handling",
  async (outcome) => {
    auth.getAccessToken.mockResolvedValue(jwt(1));
    const { peer, close } = setup();
    try {
      await waitFor(() => expect(peer.active.size).toBe(9));
      vi.mocked(Sentry.captureMessage).mockImplementation(() => {
        throw new Error("logging unavailable");
      });
      vi.mocked(reportCaught).mockImplementation(() => {
        throw new Error("logging unavailable");
      });
      if (outcome === "success") auth.getAccessToken.mockResolvedValue(jwt(2));
      await act(async () => peer.rejectIdentity());
      await waitFor(() =>
        expect(peer.active.size).toBe(outcome === "success" ? 9 : 0),
      );
      expect(peer.unauthenticatedAdds).toEqual([]);
      expect(useSessionRefreshStore.getState().queriesPaused).toBe(
        outcome === "failure",
      );
    } finally {
      await close();
    }
  },
);

it("changing accounts never clears identity while app subscriptions remain", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  const { peer, rerender, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    auth.user = { id: "other-user" };
    auth.getAccessToken.mockResolvedValue(jwt(2));
    rerender();
    await waitFor(() => expect(peer.active.size).toBe(9));
    expect(peer.clearCounts.every((count) => count === 0)).toBe(true);
    expect(peer.unauthenticatedAdds).toEqual([]);
  } finally {
    await close();
  }
});

it("upstream logout cancels ungated queries before clearing authentication", async () => {
  auth.getAccessToken.mockResolvedValue(jwt(1));
  guest.mint.mockReturnValue(new Promise(() => {}));
  const { peer, view, rerender, close } = setup();
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    auth.user = null;
    rerender();
    await waitFor(() => expect(peer.active.size).toBe(0));
    expect(view.queryByText("App content")).toBeNull();
    expect(peer.clearCounts.every((count) => count === 0)).toBe(true);
    expect(peer.unauthenticatedAdds).toEqual([]);
  } finally {
    await close();
  }
});

it("a sibling guest promotion removes every SDK subscription before identity loss", async () => {
  auth.user = null;
  guest.cached = { token: jwt(1), guestId: "protocol-guest" };
  guest.mint.mockResolvedValue(guest.cached);
  guestTabRecovery.setGuest(null);
  const { peer, client, close } = setup(true);
  try {
    await waitFor(() => expect(peer.active.size).toBe(9));
    await act(async () =>
      guestTabRecovery.receive({
        guestId: "protocol-guest",
        attempt: "promotion",
        startedAt: Date.now(),
        phase: "started",
      }),
    );
    await waitFor(() => expect(peer.active.size).toBe(0));
    await act(async () => client.clearAuth());
    expect(peer.clearCounts.every((count) => count === 0)).toBe(true);
    expect(peer.unauthenticatedAdds).toEqual([]);
  } finally {
    await close();
    guestTabRecovery.setGuest(null);
  }
});
