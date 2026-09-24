import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConvexReactClient, useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import {
  DbUserReadyProvider,
  useDbUserReady,
} from "@/contexts/db-user-ready-context";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { useUnifiedConvexAuth } from "../unified-convex-auth";

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  user: { id: "test-user" },
  isLoading: false,
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));
vi.mock("@/lib/guest-session", () => ({
  getCachedGuestSession: () => null,
  getOrCreateGuestSessionOrThrow: vi.fn(),
  forceRefreshGuestSessionOrThrow: vi.fn(),
  markGuestActivated: vi.fn(),
  getGuestSessionRefusal: () => null,
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
function Shell() {
  const { isAuthenticated } = useConvexAuth();
  // The test actor already has its database row; only auth/readiness changes.
  return (
    <DbUserReadyProvider isUserReady={isAuthenticated}>
      {names.map((name) => (
        <ProtectedQuery key={name} name={name} />
      ))}
    </DbUserReadyProvider>
  );
}

// A protocol peer, not a mock Convex client. It accepts test JWTs and supplies
// successful query results. We never inject auth/query errors: assertions inspect
// the actual SDK's outgoing auth and subscription messages.
function protocolPeer() {
  const active = new Set<number>();
  const clearCounts: number[] = [];
  let version = { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" };
  let timestamp = 0;
  let hold = false;
  const pending: Array<() => void> = [];
  class Socket {
    readyState = 0;
    onopen?: (event: object) => void;
    onclose?: (event: object) => void;
    onmessage?: (event: { data: string }) => void;
    constructor() {
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
      if (message.type === "Authenticate") {
        if (message.tokenType === "None") clearCounts.push(active.size);
        this.transition({ ...version, identity: message.baseVersion + 1 }, []);
      }
      if (message.type === "ModifyQuerySet") {
        const updates = [];
        for (const change of message.modifications) {
          if (change.type === "Add") {
            active.add(change.queryId);
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
  auth.getAccessToken.mockReset();
  useSessionRefreshStore.setState({
    status: "idle",
    kind: null,
    retryNonce: 0,
    queriesPaused: false,
    pauseQueries,
  });
});
afterEach(() => useSessionRefreshStore.setState({ pauseQueries }));

it.each([false, true])(
  "refresh failure with query guard=%s, then recovery",
  async (guard) => {
    if (!guard) useSessionRefreshStore.setState({ pauseQueries: () => {} });
    const peer = protocolPeer();
    let calls = 0;
    let recovering = false;
    auth.getAccessToken.mockImplementation(async () => {
      calls++;
      if (calls >= 3 && !recovering) throw new TypeError("Failed to fetch");
      return jwt(calls);
    });
    const client = new ConvexReactClient("https://test.convex.cloud", {
      webSocketConstructor: peer.Socket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
      authRefreshTokenLeewaySeconds: 2,
      logger: false,
    });
    const view = render(
      <ConvexProviderWithAuthKit client={client} useAuth={useUnifiedConvexAuth}>
        <Shell />
      </ConvexProviderWithAuthKit>,
    );
    try {
      await waitFor(() => expect(peer.active.size).toBe(8));
      await waitFor(() => expect(peer.clearCounts.length).toBeGreaterThan(0), {
        timeout: 10000,
      });
      expect(peer.clearCounts[0]).toBe(guard ? 0 : 8);
      await waitFor(() => expect(peer.active.size).toBe(0));
      expect(useSessionRefreshStore.getState().status).toBe("failed");
      recovering = true;
      peer.holdConfirmations();
      act(() => useSessionRefreshStore.getState().retry());
      await waitFor(() =>
        expect(peer.pendingConfirmations()).toBeGreaterThan(0),
      );
      await waitFor(() =>
        expect(useSessionRefreshStore.getState().status).toBe("idle"),
      );
      // A returned token is not confirmation that the server accepted it.
      expect(peer.active.size).toBe(0);
      if (guard)
        expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
      await act(async () => {
        peer.releaseConfirmations();
      });
      await waitFor(() => expect(peer.active.size).toBe(8));
      expect(useSessionRefreshStore.getState().status).toBe("idle");
      if (guard)
        expect(peer.clearCounts.every((count) => count === 0)).toBe(true);
    } finally {
      view.unmount();
      await client.close();
    }
  },
  15000,
);
