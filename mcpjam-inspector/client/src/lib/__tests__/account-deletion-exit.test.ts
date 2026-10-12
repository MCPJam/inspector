import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  prepare: vi.fn(),
  claim: vi.fn(),
  discard: vi.fn(),
  activate: vi.fn(),
  disconnect: vi.fn(),
  close: vi.fn(),
  assign: vi.fn(),
}));
vi.mock("@mcpjam/sdk/account-deletion", async (original) => ({
  ...(await original<typeof import("@mcpjam/sdk/account-deletion")>()),
  AccountDeletionClient: vi.fn().mockImplementation(function () {
    return { request: mocks.request };
  }),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
vi.mock("../account-deletion-storage", () => ({
  prepareAccountDeletion: mocks.prepare,
  claimAccountDeletion: mocks.claim,
  discardAccountDeletion: mocks.discard,
  activateAccountDeletion: mocks.activate,
}));
vi.mock("@/state/mcp-api", () => ({
  disconnectAllRuntimeServers: mocks.disconnect,
}));
vi.mock("@/stores/webmcp-inspector-store", () => ({
  useWebmcpInspectorStore: {
    getState: () => ({
      session: { sessionId: "local" },
      closeSession: mocks.close,
    }),
  },
}));
vi.mock("@/lib/auth/pause-queries-before-auth-clear", () => ({
  pauseQueriesBeforeAuthClear: () =>
    useSessionRefreshStore.getState().pauseQueries(),
}));
import { AccountDeletionError } from "@mcpjam/sdk/account-deletion";
import {
  startAccountDeletion as startFlow,
  useAccountDeletionFlow,
} from "../account-deletion-flow";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import {
  resetSignOutLatchForTests,
  markSignOutInProgress,
  isSignOutInProgress,
  ownsSignOut,
} from "@/lib/auth/sign-out-latch";
function startAccountDeletion(
  actorSubject: string,
  checkpoint: string,
  signOut: Parameters<typeof startFlow>[2],
  currentActorSubject: () => string | undefined = () => actorSubject,
) {
  return startFlow(actorSubject, checkpoint, signOut, currentActorSubject);
}
const pending = {
  localId: "local-receipt",
  actorSubject: "user_a",
  receiptSecret: "a".repeat(64),
  idempotencyKey: "original-key",
};
beforeEach(() => {
  vi.clearAllMocks();
  resetSignOutLatchForTests();
  useAccountDeletionFlow.setState({ busy: false, error: "" });
  useSessionRefreshStore.setState({
    queriesPaused: false,
    authConfirmed: true,
    authEpoch: 5,
  });
  vi.stubGlobal("window", {
    location: { origin: "https://synthetic.local", assign: mocks.assign },
  });
  mocks.prepare.mockResolvedValue(pending);
  mocks.claim.mockResolvedValue(true);
  mocks.request.mockResolvedValue({ state: "accepted" });
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.discard.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetSignOutLatchForTests();
});
it.each(["accepted", "uncertain"])(
  "%s response after actor switch preserves the original receipt without affecting the new actor",
  async (outcome) => {
    let actor: string | undefined = "user_a";
    const signOut = vi.fn();
    mocks.request.mockImplementation(async () => {
      actor = "user_b";
      if (outcome === "uncertain")
        throw new AccountDeletionError(0, "ACCOUNT_DELETION_TRANSPORT_FAILED");
      return { state: "accepted" };
    });
    await startAccountDeletion("user_a", "checkpoint", signOut, () => actor);
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledWith(pending.localId);
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(isSignOutInProgress()).toBe(false);
    expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
  },
);
it("rechecks the actor inside deferred cleanup and leaves a changed epoch paused", async () => {
  let actor = "user_a";
  const signOut = vi.fn();
  mocks.disconnect.mockImplementation(async () => {
    actor = "user_b";
    useSessionRefreshStore.setState({ authEpoch: 6 });
  });
  await startAccountDeletion("user_a", "checkpoint", signOut, () => actor);
  expect(mocks.disconnect).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(isSignOutInProgress()).toBe(false);
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
});
it("revoked original identity can recover without invoking cleanup or logout", async () => {
  let actor: string | undefined = "user_a";
  mocks.request.mockImplementation(async () => {
    actor = undefined;
    return { state: "accepted" };
  });
  const signOut = vi.fn();
  await startAccountDeletion("user_a", "checkpoint", signOut, () => actor);
  expect(mocks.disconnect).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(mocks.assign).toHaveBeenCalledWith(
    "https://synthetic.local/account-deletion/receipt/local-receipt",
  );
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("actor switch during logout cannot redirect the new actor or remove original recovery", async () => {
  let actor = "user_a";
  const signOut = vi.fn(async () => {
    actor = "user_b";
  });
  await startAccountDeletion("user_a", "checkpoint", signOut, () => actor);
  expect(signOut).toHaveBeenCalledOnce();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(isSignOutInProgress()).toBe(false);
});
it("accepted response cannot overwrite an unrelated newer exit", async () => {
  let newerOwner = 0;
  mocks.request.mockImplementation(async () => {
    newerOwner = markSignOutInProgress();
    return { state: "accepted" };
  });
  const signOut = vi.fn();
  await startAccountDeletion("user_a", "checkpoint", signOut);
  expect(ownsSignOut(newerOwner)).toBe(true);
  expect(mocks.disconnect).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
});
