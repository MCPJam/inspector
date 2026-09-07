import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local Claude Code controller.
 *
 * Everything here is about the three pieces of state staying apart. The shape
 * this replaced collapsed them into two booleans, and each test below pins a
 * failure that collapse produced: a requested target lost when readiness
 * changed, a default invented from a failed fetch, a poll that could not tell
 * "the status read failed" from "the install failed", an approval that
 * outlived the thing it approved, and a grant persisted into a context that
 * had moved on while it was in flight.
 */

const {
  fetchAvailabilityMock,
  fetchRuntimeStatusMock,
  startInstallMock,
  registerWorkspaceMock,
  mintConsentMock,
  revokeGrantIdMock,
  revokeConsentMock,
  flagMock,
} = vi.hoisted(() => ({
  fetchAvailabilityMock: vi.fn(),
  fetchRuntimeStatusMock: vi.fn(),
  startInstallMock: vi.fn(),
  registerWorkspaceMock: vi.fn(),
  mintConsentMock: vi.fn(),
  revokeGrantIdMock: vi.fn(async () => {}),
  revokeConsentMock: vi.fn(async () => {}),
  flagMock: vi.fn(() => true),
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalHarnessEnabled: flagMock,
}));
vi.mock("@/lib/local-harness-consent", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/local-harness-consent")
  >("@/lib/local-harness-consent");
  return {
    ...actual,
    fetchLocalHarnessAvailability: fetchAvailabilityMock,
    fetchLocalHarnessRuntimeStatus: fetchRuntimeStatusMock,
    startLocalHarnessRuntimeInstall: startInstallMock,
    registerLocalHarnessWorkspace: registerWorkspaceMock,
    mintLocalHarnessConsent: mintConsentMock,
    revokeLocalHarnessGrantId: revokeGrantIdMock,
    revokeLocalHarnessConsent: revokeConsentMock,
  };
});

import {
  loadStoredHarnessTarget,
  resetSessionHarnessTargetsForTests,
  saveHarnessTarget,
  useLocalHarnessController,
} from "../useLocalHarnessTarget";
import {
  localHarnessConsentStorageKey,
  type LocalHarnessAvailabilityView,
} from "@/lib/local-harness-consent";

const PROJECT = "proj-1";
const DIGEST = `sha256:${"a".repeat(64)}`;

const AVAILABILITY: LocalHarnessAvailabilityView = {
  available: true,
  status: "ok",
  message: null,
  platform: "darwin",
  machineId: "mach_1",
  keyFingerprint: "fp",
  permissionProfile: "workspace-edits",
  policyVersion: "local-harness-policy-2026-09-01",
  runtime: null,
  runtimeStatus: { state: "absent", packVersion: "3.4.0" },
  runtimeRootConfigured: true,
  hostedAvailable: false,
  expectedPack: { packVersion: "3.4.0", treeDigest: DIGEST },
  suggestedWorkspace: { displayRoot: "~/code/project" },
};

const EXPECTATIONS = {
  machineId: "mach_1",
  packVersion: "3.4.0",
  treeDigest: DIGEST,
  permissionProfile: "workspace-edits",
  policyVersion: "local-harness-policy-2026-09-01",
};

function storedConsent(overrides: Record<string, unknown> = {}) {
  return {
    grantId: "grant_1",
    token: "t".repeat(32),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    target: {
      kind: "local-native",
      harnessId: "claude-code",
      machineId: "mach_1",
      workspaceGrantId: "ws_1",
      runtimeId: "rt_1",
      permissionProfile: "workspace-edits",
      policyVersion: "local-harness-policy-2026-09-01",
    },
    workspaceDisplayRoot: "~/code/project",
    runtime: {
      runtimeId: "rt_1",
      adapterVersion: "1.0.0",
      digest: DIGEST,
      packVersion: "3.4.0",
    },
    grantedAt: new Date().toISOString(),
    ...overrides,
  };
}

function render(args: Partial<Parameters<typeof useLocalHarnessController>[0]> = {}) {
  return renderHook((props: Record<string, unknown> = {}) =>
    useLocalHarnessController({
      projectId: PROJECT,
      userKey: "member",
      inScope: true,
      scopeKey: "host-1:claude-code",
      ...args,
      ...props,
    } as never),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Module state, so `localStorage.clear()` does not reach it. The controller
  // records its derived default through `saveHarnessTarget`, which means one
  // test's default was readable as the next test's stored preference.
  resetSessionHarnessTargetsForTests();
  flagMock.mockReturnValue(true);
  fetchAvailabilityMock.mockResolvedValue({
    ok: true,
    availability: AVAILABILITY,
  });
  fetchRuntimeStatusMock.mockResolvedValue({
    ok: true,
    status: { state: "absent", packVersion: "3.4.0" },
  });
  registerWorkspaceMock.mockResolvedValue({
    ok: true,
    workspaceGrantId: "ws_1",
    displayRoot: "~/code/project",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what the user asked for is preserved", () => {
  it("keeps an explicit local request through a consent change", async () => {
    localStorage.setItem(`mcp-local-harness-target-v1:${PROJECT}`, "local-native");
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requestedTarget).toBe("local-native");
    // The grant is what an EFFECTIVE target needs. Losing the request when it
    // arrives (or leaves) is what turned a deliberate local turn into a cloud
    // one with no indication.
    expect(result.current.effectiveTarget).toBe("hosted");

    act(() => {
      localStorage.setItem(
        localHarnessConsentStorageKey(PROJECT),
        JSON.stringify(storedConsent()),
      );
      window.dispatchEvent(new CustomEvent("local-harness-consent-changed"));
    });
    await waitFor(() =>
      expect(result.current.effectiveTarget).toBe("local-native"),
    );
    expect(result.current.requestedTarget).toBe("local-native");
  });

  it("defaults to local ONLY when the server says there is no cloud target", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requestedTarget).toBe("local-native");
    expect(result.current.hostedAvailable).toBe(false);
  });

  it("invents no default while availability is unknown", async () => {
    // Loading, a failed fetch and a 401 are all "we do not know". Picking
    // either way from one of them hides a real option or claims one that does
    // not exist.
    fetchAvailabilityMock.mockResolvedValue({
      ok: false,
      kind: "network",
      status: null,
      message: "offline",
    });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requestedTarget).toBeNull();
    expect(result.current.hostedAvailable).toBeNull();
    // And a network failure is not "unavailable" — it says nothing about this
    // machine, so the honest phase is that we still do not know.
    expect(result.current.phase).toBe("loading");
  });

  it("does not default to local when a cloud target also exists", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: { ...AVAILABILITY, hostedAvailable: true },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requestedTarget).toBeNull();
    expect(result.current.hostedAvailable).toBe(true);
  });
});

describe("the target survives a browser that will not store it", () => {
  // A private window, blocked site data or a full quota all make `setItem`
  // throw. That used to lose the write AND the notify with it, because
  // `dispatchEvent` sat inside the same `try` after the call that threw.
  //
  // The consequence is not cosmetic: `requestedTarget` still derives
  // `local-native` on a machine with no cloud target, so the turn runs on the
  // user's machine while `useLocalHarnessRunsHere` reads nothing and labels the
  // tools "runs in sandbox" — the one claim this feature must never make.
  it("keeps a target that localStorage refused, and still notifies", () => {
    resetSessionHarnessTargetsForTests();
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const notified = vi.fn();
    window.addEventListener("local-harness-target-changed", notified);
    try {
      saveHarnessTarget(PROJECT, "local-native");
      expect(setItem).toHaveBeenCalled();
      expect(loadStoredHarnessTarget(PROJECT)).toBe("local-native");
      // Subscribers have to hear about it, or the surfaces reading through
      // `useSyncExternalStore` never re-read.
      expect(notified).toHaveBeenCalled();
    } finally {
      window.removeEventListener("local-harness-target-changed", notified);
      setItem.mockRestore();
      resetSessionHarnessTargetsForTests();
    }
  });

  it("prefers a refused choice over the stale one storage still holds", () => {
    // The narrow case the first fix missed: storage worked once, so it holds a
    // real value, and then started refusing. Reading storage first meant the
    // OLD accepted value outranked the new refused one, and the user's change
    // was dropped while the previous target kept answering.
    resetSessionHarnessTargetsForTests();
    saveHarnessTarget(PROJECT, "hosted");
    expect(loadStoredHarnessTarget(PROJECT)).toBe("hosted");

    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      saveHarnessTarget(PROJECT, "local-native");
      expect(loadStoredHarnessTarget(PROJECT)).toBe("local-native");
    } finally {
      setItem.mockRestore();
    }

    // And once storage accepts again, it is authoritative once more — the
    // fallback must not keep speaking for a key it no longer owns.
    saveHarnessTarget(PROJECT, "hosted");
    expect(loadStoredHarnessTarget(PROJECT)).toBe("hosted");
    resetSessionHarnessTargetsForTests();
  });

  it("yields to another tab that stored a target this one could not", async () => {
    // A `storage` event never runs THIS tab's `saveHarnessTarget`, so nothing
    // in the save path can clear the fallback for a cross-tab write. Without
    // the listener doing it, the local unstored choice kept answering here
    // until a reload, while every other tab had moved on.
    resetSessionHarnessTargetsForTests();
    const key = `mcp-local-harness-target-v1:${PROJECT}`;
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    saveHarnessTarget(PROJECT, "local-native");
    setItem.mockRestore();
    expect(loadStoredHarnessTarget(PROJECT)).toBe("local-native");

    // Mounting the controller registers the `storage` listener that does the
    // clearing; the hook is the only thing that subscribes in production.
    const { result } = render();
    await waitFor(() => expect(result.current.phase).not.toBe("loading"));

    // Another tab's write. jsdom does not emit `storage` for same-document
    // writes, so the event is dispatched explicitly after the value lands.
    localStorage.setItem(key, "hosted");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: "hosted" }),
      );
    });

    expect(loadStoredHarnessTarget(PROJECT)).toBe("hosted");
    resetSessionHarnessTargetsForTests();
  });

  it("prefers what localStorage holds once it works again", () => {
    resetSessionHarnessTargetsForTests();
    saveHarnessTarget(PROJECT, "hosted");
    expect(loadStoredHarnessTarget(PROJECT)).toBe("hosted");
    resetSessionHarnessTargetsForTests();
  });
});

describe("phases", () => {
  it("asks for sign-in on a 401, not 'unavailable'", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: false,
      kind: "unauthenticated",
      status: 401,
      message: "sign in",
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("needs-signin"));
  });

  it("reaches needs-signin for a signed-out user rather than hiding", async () => {
    const { result } = render({ userKey: null });
    await waitFor(() => expect(result.current.phase).toBe("needs-signin"));
  });

  it("waits rather than saying 'sign in' while the member is still loading", async () => {
    // `undefined` is the caller's Convex query in flight, not a signed-out
    // user. Reading it as signed out told a signed-in member to sign in, and
    // disabled Allow, for the whole window that query took — on a session that
    // had already passed availability.
    const { result } = render({ userKey: undefined });
    await waitFor(() => expect(result.current.phase).toBe("loading"));
    expect(result.current.reason).toBeNull();
  });

  it("is unavailable out of scope, without fetching anything", async () => {
    const { result } = render({ inScope: false });
    await waitFor(() => expect(result.current.phase).toBe("unavailable"));
    expect(fetchAvailabilityMock).not.toHaveBeenCalled();
  });

  it("is unavailable when the feature flag is off, and asks nothing", async () => {
    // The route would answer, and the answer is a fact about this machine a
    // dark-launched user has no business learning.
    flagMock.mockReturnValue(false);
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("unavailable"));
    expect(fetchAvailabilityMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed install with its reason, not as 'absent'", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "failed",
          packVersion: "3.4.0",
          reason: "network",
          message: "the runtime could not be downloaded",
        },
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("failed"));
    expect(result.current.reason).toMatch(/could not be downloaded/);
  });

  it("surfaces an interrupted attempt as its own recoverable state", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "interrupted",
          packVersion: "3.4.0",
          message: "setup was interrupted",
        },
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("interrupted"));
  });

  it("is ready with a runtime and a grant", async () => {
    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(storedConsent()),
    );
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "ready",
          packVersion: "3.4.0",
          runtimeRoot: "/r",
          digest: DIGEST,
        },
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("ready"));
  });

  it("is not ready when the pack was rebuilt at the same version", async () => {
    // The version matched and the TREE did not. Comparing the version alone
    // kept the grant `ready` across a rebuild, so Send skipped the dialog and
    // the server refused the runtime id the grant is bound to — a failed turn
    // instead of the one screen that would have fixed it.
    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(
        storedConsent({
          runtime: {
            runtimeId: "rt_1",
            adapterVersion: "1.0.0",
            digest: `sha256:${"b".repeat(64)}`,
            packVersion: "3.4.0",
          },
        }),
      ),
    );
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "ready",
          packVersion: "3.4.0",
          runtimeRoot: "/r",
          digest: DIGEST,
        },
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("needs-consent"));
    expect(result.current.resolveSendTarget()).toBeNull();
  });
});

describe("polling", () => {
  it("watches a running install and stops at a terminal result", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "downloading",
          packVersion: "3.4.0",
          percent: 10,
          attemptId: "att_1",
        },
      },
    });
    fetchRuntimeStatusMock.mockResolvedValue({
      ok: true,
      status: {
        state: "ready",
        packVersion: "3.4.0",
        runtimeRoot: "/r",
        digest: DIGEST,
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("installing"));
    await waitFor(
      () => expect(result.current.runtimeStatus?.state).toBe("ready"),
      { timeout: 4_000 },
    );
    const callsAtRest = fetchRuntimeStatusMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 1_500));
    // Terminal means terminal: no further reads.
    expect(fetchRuntimeStatusMock.mock.calls.length).toBe(callsAtRest);
  });

  it("never starts work from a poll", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "downloading",
          packVersion: "3.4.0",
          percent: 10,
        },
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("installing"));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(startInstallMock).not.toHaveBeenCalled();
    expect(mintConsentMock).not.toHaveBeenCalled();
  });

  it("tells a failed status READ apart from a failed install", async () => {
    // Saying "your download failed" because a loopback read hiccupped sends a
    // user to retry something that is still running.
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "downloading",
          packVersion: "3.4.0",
          percent: 10,
        },
      },
    });
    fetchRuntimeStatusMock.mockResolvedValue({
      ok: false,
      kind: "network",
      status: null,
      message: "offline",
    });
    const { result } = render();
    await waitFor(() => expect(result.current.statusFetchFailed).toBe(true), {
      timeout: 4_000,
    });
    expect(result.current.phase).toBe("installing");
  });

  it("drops a late response from a superseded attempt", async () => {
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "downloading",
          packVersion: "3.4.0",
          percent: 5,
          attemptId: "att_new",
        },
      },
    });
    startInstallMock.mockResolvedValue({
      ok: true,
      kind: "accepted",
      attemptId: "att_new",
      status: {
        state: "downloading",
        packVersion: "3.4.0",
        percent: 0,
        attemptId: "att_new",
      },
      statusUrl: "/s",
      retryAfterSeconds: 1,
    });
    // The poll answers for the PREVIOUS attempt.
    fetchRuntimeStatusMock.mockResolvedValue({
      ok: true,
      status: {
        state: "downloading",
        packVersion: "3.4.0",
        percent: 90,
        attemptId: "att_old",
      },
    });
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("installing"));
    // Through the real gesture: an install with no approval behind it is
    // refused, so the attempt to observe would never be selected either.
    await act(async () => {
      await result.current.chooseWorkspace({ useSuggested: true });
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
      await result.current.startInstall();
    });
    await new Promise((r) => setTimeout(r, 1_500));
    // 90% from the loser must not overwrite the winner's 0%.
    expect(result.current.runtimeStatus?.percent).toBe(0);
  });
});

describe("pending approval", () => {
  async function readyToApprove() {
    const rendered = render();
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    await act(async () => {
      await rendered.result.current.chooseWorkspace({ useSuggested: true });
    });
    return rendered;
  }

  it("sees a workspace registered in the SAME tick", async () => {
    // The dialog registers the suggested folder and captures the approval
    // without a render in between. Reading the render closure there meant the
    // very first Install & allow captured nothing and reported "choose a
    // folder" for a folder that had just been registered.
    const rendered = render();
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    let approval: unknown;
    await act(async () => {
      await rendered.result.current.chooseWorkspace({ useSuggested: true });
      approval = rendered.result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    expect(approval).toMatchObject({ workspaceGrantId: "ws_1" });
  });

  it("returns the registered workspace, so a caller need not wait for state", async () => {
    const rendered = render();
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    const outcome = await act(async () =>
      rendered.result.current.chooseWorkspace({ useSuggested: true }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      workspace: { workspaceGrantId: "ws_1", displayRoot: "~/code/project" },
    });
  });

  it("is captured only by an explicit approval, and downloads nothing", async () => {
    const { result } = await readyToApprove();
    expect(result.current.pendingApproval).toBeNull();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    expect(result.current.pendingApproval).not.toBeNull();
    expect(startInstallMock).not.toHaveBeenCalled();
  });

  it("is discarded on cancel", async () => {
    const { result } = await readyToApprove();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    act(() => result.current.cancelApproval());
    expect(result.current.pendingApproval).toBeNull();
  });

  it("is discarded when the signed-in user changes", async () => {
    const { result, rerender } = await readyToApprove();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    rerender({ userKey: "somebody-else" } as never);
    await waitFor(() => expect(result.current.pendingApproval).toBeNull());
  });

  it("is discarded when the host or surface changes", async () => {
    const { result, rerender } = await readyToApprove();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    rerender({ scopeKey: "host-2:claude-code" } as never);
    await waitFor(() => expect(result.current.pendingApproval).toBeNull());
  });

  it("is discarded when it leaves scope entirely", async () => {
    const { result, rerender } = await readyToApprove();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    rerender({ inScope: false } as never);
    await waitFor(() => expect(result.current.pendingApproval).toBeNull());
  });

  it("is discarded when the runtime this build expects changes", async () => {
    // Approving 3.4.0 is not approving 3.5.0. Consent binds to a runtime
    // identity, so a server update between the click and the mint means the
    // click no longer describes what would run.
    const { result } = await readyToApprove();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    expect(result.current.pendingApproval).not.toBeNull();
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        expectedPack: { packVersion: "3.5.0", treeDigest: DIGEST },
      },
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.pendingApproval).toBeNull());
  });

  it("is discarded when the policy version changes", async () => {
    const { result } = await readyToApprove();
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: { ...AVAILABILITY, policyVersion: "policy-2027-01-01" },
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.pendingApproval).toBeNull());
  });
});

describe("authorizing", () => {
  async function approved() {
    const rendered = render();
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    await act(async () => {
      await rendered.result.current.chooseWorkspace({ useSuggested: true });
    });
    act(() => {
      rendered.result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    return rendered;
  }

  it("mints against the approved expectations and persists once", async () => {
    mintConsentMock.mockResolvedValue({ ok: true, consent: storedConsent() });
    const { result } = await approved();
    await act(async () => {
      await result.current.authorize();
    });
    expect(mintConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({ expect: EXPECTATIONS, workspaceGrantId: "ws_1" }),
    );
    expect(
      localStorage.getItem(localHarnessConsentStorageKey(PROJECT)),
    ).toContain("grant_1");
    // Spent: the approval does not linger to be used twice.
    expect(result.current.pendingApproval).toBeNull();
  });

  it("refuses to grant from readiness alone, with no approval", async () => {
    const rendered = render();
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    const outcome = await rendered.result.current.authorize();
    expect(outcome.ok).toBe(false);
    expect(mintConsentMock).not.toHaveBeenCalled();
  });

  it("discards a grant that lands after its approval was cancelled", async () => {
    // The late-result case. A capability nobody currently authorizes is not
    // consent, so it is thrown away — and THAT grant id alone is revoked.
    let release: (() => void) | null = null;
    mintConsentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, consent: storedConsent() });
        }),
    );
    const { result } = await approved();
    let outcome: unknown;
    await act(async () => {
      const pending = result.current.authorize().then((value) => {
        outcome = value;
      });
      result.current.cancelApproval();
      release?.();
      await pending;
    });
    expect((outcome as { ok: boolean }).ok).toBe(false);
    expect(localStorage.getItem(localHarnessConsentStorageKey(PROJECT))).toBeNull();
    expect(revokeGrantIdMock).toHaveBeenCalledWith("grant_1");
  });

  it("does not revive consent a cancel destroyed, nor clear a newer one", async () => {
    // Another tab granted while this one's approval was in flight. Cancelling
    // must revoke only the grant THIS flow produced; clearing storage would be
    // the cancel silently destroying a valid authorization.
    let release: (() => void) | null = null;
    mintConsentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              consent: storedConsent({ grantId: "grant_late" }),
            });
        }),
    );
    const { result } = await approved();
    await act(async () => {
      const pending = result.current.authorize();
      localStorage.setItem(
        localHarnessConsentStorageKey(PROJECT),
        JSON.stringify(storedConsent({ grantId: "grant_from_other_tab" })),
      );
      result.current.cancelApproval();
      release?.();
      await pending;
    });
    expect(
      localStorage.getItem(localHarnessConsentStorageKey(PROJECT)),
    ).toContain("grant_from_other_tab");
    expect(revokeGrantIdMock).toHaveBeenCalledWith("grant_late");
  });

  it("passes a 409 through so the dialog can re-ask with fresh terms", async () => {
    mintConsentMock.mockResolvedValue({
      ok: false,
      kind: "conflict",
      status: 409,
      message: "what you approved is not what this machine would run now",
      reason: "consent-context-changed",
      changed: ["packVersion"],
      current: { packVersion: "3.5.0" },
    });
    const { result } = await approved();
    const outcome = await act(async () => result.current.authorize());
    expect(outcome).toMatchObject({
      ok: false,
      kind: "conflict",
      reason: "consent-context-changed",
    });
    expect(localStorage.getItem(localHarnessConsentStorageKey(PROJECT))).toBeNull();
  });
});

describe("installing", () => {
  it("refuses to download with nothing approved behind it", async () => {
    // A ~200 MB download is a thing a human asks for, and there is exactly one
    // gesture that asks. An install with no approval is a caller that found
    // another way in.
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const outcome = await act(async () => result.current.startInstall());
    expect(outcome).toMatchObject({ ok: false });
    expect(startInstallMock).not.toHaveBeenCalled();
  });

  it("sends the approved pack so the server can refuse a different one", async () => {
    startInstallMock.mockResolvedValue({
      ok: true,
      kind: "accepted",
      attemptId: "att_1",
      status: { state: "downloading", packVersion: "3.4.0", percent: 0 },
      statusUrl: "/s",
      retryAfterSeconds: 1,
    });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.chooseWorkspace({ useSuggested: true });
    });
    act(() => {
      result.current.captureApproval({
        expectations: EXPECTATIONS,
        scopeKey: "host-1:claude-code",
      });
    });
    await act(async () => {
      await result.current.startInstall();
    });
    expect(startInstallMock).toHaveBeenCalledWith({
      expectedPack: { packVersion: "3.4.0", treeDigest: DIGEST },
    });
  });
});

describe("the send snapshot", () => {
  it("reads storage at call time, not from the render it was built in", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const resolve = result.current.resolveSendTarget;
    expect(resolve()).toBeNull();

    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(storedConsent()),
    );
    // The SAME closure now answers with the fresh grant.
    expect(resolve()).toMatchObject({ token: "t".repeat(32) });
  });

  it("refuses an expired grant without waiting for a re-render", async () => {
    // A sleeping laptop's timers do not fire. The pre-send check is the
    // guarantee; the timer is the convenience.
    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(
        storedConsent({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      ),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolveSendTarget()).toBeNull();
  });

  it("refuses once the user signs out, whatever storage still holds", async () => {
    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(storedConsent()),
    );
    const { result } = render({ userKey: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolveSendTarget()).toBeNull();
  });

  it("refuses out of scope", async () => {
    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(storedConsent()),
    );
    const { result } = render({ inScope: false });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolveSendTarget()).toBeNull();
  });
});

describe("expiry", () => {
  it("stops being ready when the grant's clock runs out", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      localHarnessConsentStorageKey(PROJECT),
      JSON.stringify(
        storedConsent({ expiresAt: new Date(Date.now() + 5_000).toISOString() }),
      ),
    );
    fetchAvailabilityMock.mockResolvedValue({
      ok: true,
      availability: {
        ...AVAILABILITY,
        runtimeStatus: {
          state: "ready",
          packVersion: "3.4.0",
          runtimeRoot: "/r",
          digest: DIGEST,
        },
      },
    });
    const { result } = render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.consent).not.toBeNull();

    // A timer that only re-read the same storage string could not notice this:
    // the string is unchanged and the expiry comparison lives in the parse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(result.current.consent).toBeNull();
    expect(result.current.effectiveTarget).toBe("hosted");
  });
});
