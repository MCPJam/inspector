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
it("persists and claims before dispatch, pauses queries, and clears auth before receipt navigation", async () => {
  const signOut = vi.fn(async () => undefined);
  mocks.request.mockImplementation(async () => {
    expect(mocks.prepare).toHaveBeenCalledWith("user_a");
    expect(mocks.claim).toHaveBeenCalledWith(pending.localId);
    expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
    expect(isSignOutInProgress()).toBe(true);
  });
  await startAccountDeletion("user_a", "c".repeat(64), signOut);
  expect(mocks.request).toHaveBeenCalledWith({
    receiptSecret: pending.receiptSecret,
    idempotencyKey: pending.idempotencyKey,
    ownershipCheckpointSha256: "c".repeat(64),
  });
  expect(signOut).toHaveBeenCalledWith({
    navigate: false,
    returnTo: "https://synthetic.local/account-deletion/receipt/local-receipt",
  });
  expect(mocks.assign).toHaveBeenCalledWith(
    "https://synthetic.local/account-deletion/receipt/local-receipt",
  );
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("unknown response retains the original secret/key and navigates to receipt only", async () => {
  mocks.request.mockRejectedValue(
    new AccountDeletionError(0, "ACCOUNT_DELETION_TRANSPORT_FAILED"),
  );
  const signOut = vi.fn(async () => undefined);
  await startAccountDeletion("user_a", "checkpoint", signOut);
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(signOut).toHaveBeenCalledOnce();
  expect(mocks.assign).toHaveBeenCalledOnce();
});
it("known rejection restores an originally active query gate and releases its own latch", async () => {
  mocks.request.mockRejectedValue(
    new AccountDeletionError(409, "ACCOUNT_OWNERSHIP_CHANGED"),
  );
  const signOut = vi.fn();
  await startAccountDeletion("user_a", "checkpoint", signOut);
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
  expect(isSignOutInProgress()).toBe(false);
  expect(useAccountDeletionFlow.getState().error).toContain(
    "ownership changed",
  );
  expect(mocks.discard).toHaveBeenCalledWith(pending.localId);
  expect(signOut).not.toHaveBeenCalled();
});
it("known rejection preserves a gate that was already paused", async () => {
  useSessionRefreshStore.setState({ queriesPaused: true });
  mocks.request.mockRejectedValue(
    new AccountDeletionError(409, "ACCOUNT_OWNERSHIP_REQUIRED"),
  );
  await startAccountDeletion("user_a", "checkpoint", vi.fn());
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
});
it("known rejection cannot release an unrelated newer sign-out or auth epoch", async () => {
  mocks.request.mockImplementation(async () => {
    markSignOutInProgress();
    useSessionRefreshStore.setState({ authEpoch: 6 });
    throw new AccountDeletionError(409, "ACCOUNT_OWNERSHIP_CHANGED");
  });
  await startAccountDeletion("user_a", "checkpoint", vi.fn());
  expect(isSignOutInProgress()).toBe(true);
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
});
it("a saved attempted request cannot submit again even with capability off", async () => {
  mocks.claim.mockResolvedValue(false);
  await startAccountDeletion(
    "user_a",
    "checkpoint",
    vi.fn(async () => undefined),
  );
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(mocks.assign).toHaveBeenCalledOnce();
});
it("storage failure has no intake, logout, query pause or navigation", async () => {
  mocks.prepare.mockRejectedValue(new Error("blocked"));
  const signOut = vi.fn();
  await startAccountDeletion("user_a", "checkpoint", signOut);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
  expect(mocks.assign).not.toHaveBeenCalled();
});
it("bounded slow intake keeps only its own deliberate exit alive", async () => {
  vi.useFakeTimers();
  let accept: () => void = () => {
    throw new Error("Not initialized");
  };
  mocks.request.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const run = startAccountDeletion(
    "user_a",
    "checkpoint",
    vi.fn(async () => undefined),
  );
  await vi.advanceTimersByTimeAsync(18_000);
  expect(isSignOutInProgress()).toBe(true);
  accept();
  await run;
  expect(mocks.assign).toHaveBeenCalledOnce();
});

it("failure clearing a definitely refused record cannot reject the caller or silently start again", async () => {
  mocks.request.mockRejectedValue(
    new AccountDeletionError(409, "ACCOUNT_OWNERSHIP_CHANGED"),
  );
  mocks.discard.mockRejectedValue(new Error("database unavailable"));
  await expect(
    startAccountDeletion("user_a", "checkpoint", vi.fn()),
  ).resolves.toBeUndefined();
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(useAccountDeletionFlow.getState()).toMatchObject({
    busy: false,
    error: expect.stringContaining("recovery record could not be cleared"),
  });
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
});
it("an unexpected post-dispatch failure retains recovery and never creates a replacement", async () => {
  mocks.request.mockRejectedValue(
    new Error("unexpected transport boundary failure"),
  );
  await startAccountDeletion(
    "user_a",
    "checkpoint",
    vi.fn(async () => undefined),
  );
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.assign).toHaveBeenCalledOnce();
});
it("logout refusal after acceptance preserves the receipt and navigates without session recovery", async () => {
  await startAccountDeletion(
    "user_a",
    "checkpoint",
    vi.fn().mockRejectedValue(new Error("logout failed")),
  );
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.assign).toHaveBeenCalledOnce();
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
});

it("an exit started during awaited storage cannot be overwritten or dispatched through", async () => {
  let otherOwner = 0;
  mocks.claim.mockImplementation(async () => {
    otherOwner = markSignOutInProgress();
    useSessionRefreshStore.setState({ authEpoch: 6, queriesPaused: true });
    return true;
  });
  await startAccountDeletion("user_a", "checkpoint", vi.fn());
  expect(ownsSignOut(otherOwner)).toBe(true);
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(true);
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(mocks.discard).toHaveBeenCalledWith(pending.localId);
});

it("current actor change before token acceptance has no intake or sign-out side effects", async () => {
  const signOut = vi.fn();
  await startAccountDeletion("user_a", "checkpoint", signOut, () => "user_b");
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(mocks.discard).toHaveBeenCalledWith(pending.localId);
  expect(isSignOutInProgress()).toBe(false);
  expect(useSessionRefreshStore.getState().queriesPaused).toBe(false);
});
it("preflight refusal retains a prior uncertain submission unchanged", async () => {
  mocks.claim.mockImplementation(async () => {
    markSignOutInProgress();
    return false;
  });
  await startAccountDeletion("user_a", "checkpoint", vi.fn());
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(isSignOutInProgress()).toBe(true);
});
