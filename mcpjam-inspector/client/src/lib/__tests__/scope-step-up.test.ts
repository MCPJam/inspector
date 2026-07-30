/**
 * The shared SEP-2350 step-up lifecycle.
 *
 * The behaviours pinned here are the ones that were re-implemented per surface
 * before this module existed — and that the agent-driven entry points on
 * Prompts and Resources silently skipped: reset-on-success, drive-on-403, the
 * actionable-challenge gate, and single-flight dedup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetScopeStepUpInFlightForTests,
  beginChatTurnScopeStepUpHold,
  driveChatScopeStepUp,
  driveScopeStepUpFromChallenge,
  driveScopeStepUpFromError,
  endChatTurnScopeStepUpHold,
  resetScopeStepUp,
  resolveScopeStepUpServer,
  runWithScopeStepUp,
} from "../scope-step-up";
import { McpRequestError } from "@/lib/apis/insufficient-scope";
import type { AppState, ServerWithName } from "@/state/app-types";

const applyToolCallStepUp = vi.fn();
const resetToolCallStepUp = vi.fn();

vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...args: unknown[]) => applyToolCallStepUp(...args),
  resetToolCallStepUp: (...args: unknown[]) => resetToolCallStepUp(...args),
}));

const server = { name: "srv-1" } as unknown as ServerWithName;

/**
 * A `403 insufficient_scope` in the shape the throw-based client APIs use
 * (`McpRequestError.insufficientScope`) — the same error `readResource` /
 * `getPrompt` raise, so this exercises the real parsing path.
 */
function insufficientScopeError(scope = "files:write") {
  return new McpRequestError("Forbidden", {
    status: 403,
    insufficientScope: { requiredScope: scope },
  });
}

describe("scope step-up lifecycle", () => {
  beforeEach(() => {
    applyToolCallStepUp.mockReset().mockResolvedValue(undefined);
    resetToolCallStepUp.mockReset();
    __resetScopeStepUpInFlightForTests();
  });

  it("resets the budget on success and returns the value", async () => {
    const result = await runWithScopeStepUp(server, async () => "ok");
    expect(result).toBe("ok");
    expect(resetToolCallStepUp).toHaveBeenCalledWith(server);
    expect(applyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("drives the step-up on a 403 and re-throws the original error", async () => {
    const error = insufficientScopeError();
    await expect(
      runWithScopeStepUp(server, async () => {
        throw error;
      }),
      // The caller's own error handling must be untouched — surfaces report the
      // failure themselves (error text on screen, `execution_failed` to agents).
    ).rejects.toBe(error);
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
    expect(resetToolCallStepUp).not.toHaveBeenCalled();
  });

  it("does not reset the budget when the operation fails", async () => {
    await expect(
      runWithScopeStepUp(server, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(resetToolCallStepUp).not.toHaveBeenCalled();
  });

  it("ignores a non-403 failure", async () => {
    driveScopeStepUpFromError(server, new Error("network down"));
    expect(applyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("ignores an unactionable challenge", () => {
    // Nothing to widen: driving here would burn the one-attempt budget.
    driveScopeStepUpFromChallenge(server, {
      errorDescription: "nope",
    });
    expect(applyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("drives once while an attempt is in flight, across surfaces", async () => {
    let settle: (() => void) | undefined;
    applyToolCallStepUp.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    // Two different surfaces racing the same 403 must produce ONE redirect.
    driveScopeStepUpFromError(server, insufficientScopeError());
    driveScopeStepUpFromError(server, insufficientScopeError());
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);

    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    // Once it settles, a later 403 may step up again.
    driveScopeStepUpFromError(server, insufficientScopeError());
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct servers independent", () => {
    applyToolCallStepUp.mockImplementation(() => new Promise<void>(() => {}));
    const other = { name: "srv-2" } as unknown as ServerWithName;
    driveScopeStepUpFromError(server, insufficientScopeError());
    driveScopeStepUpFromError(other, insufficientScopeError());
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(2);
  });

  it("is inert without a server, and a failed reset never masks success", async () => {
    await expect(runWithScopeStepUp(undefined, async () => "ok")).resolves.toBe(
      "ok",
    );
    expect(resetToolCallStepUp).not.toHaveBeenCalled();

    resetToolCallStepUp.mockImplementation(() => {
      throw new Error("orchestrator exploded");
    });
    expect(() => resetScopeStepUp(server)).not.toThrow();
  });

  it("survives a rejected step-up without unhandled rejection", async () => {
    applyToolCallStepUp.mockRejectedValue(new Error("authorize failed"));
    driveScopeStepUpFromError(server, insufficientScopeError());
    await Promise.resolve();
    await Promise.resolve();
    // The in-flight guard must clear so a later attempt is still possible.
    driveScopeStepUpFromError(server, insufficientScopeError());
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(2);
  });

  const runtimeServer = {
    name: "runtime",
  } as unknown as ServerWithName;
  const projectServer = {
    name: "auth-bench",
  } as unknown as ServerWithName;
  const resolutionAppState = {
    activeProjectId: "project-1",
    servers: { runtime: runtimeServer },
    projects: {
      "project-1": {
        sharedProjectId: "convex-project-1",
        servers: { "auth-bench": projectServer },
      },
    },
  } as unknown as AppState;

  it("resolves a server from the runtime map", () => {
    expect(
      resolveScopeStepUpServer(resolutionAppState, { serverId: "runtime" }),
    ).toBe(runtimeServer);
  });

  it("resolves a server from the active-project map", () => {
    expect(
      resolveScopeStepUpServer(resolutionAppState, {
        serverId: "auth-bench",
      }),
    ).toBe(projectServer);
  });

  it("resolves a project named by its Convex/shared id", () => {
    // Hosted events can carry the shared id, which is NOT the `projects` key.
    expect(
      resolveScopeStepUpServer(resolutionAppState, {
        serverId: "auth-bench",
        projectId: "convex-project-1",
      }),
    ).toBe(projectServer);
  });
});

/**
 * Chat-triggered step-up is deferred to the end of the turn.
 *
 * The redirect is a full-page navigation and the server persists the transcript
 * only once the stream drains, so redirecting on arrival loses the very tool
 * call that raised the 403.
 */
describe("chat turn step-up deferral", () => {
  const challenge = { requiredScope: "files:write" };

  beforeEach(() => {
    applyToolCallStepUp.mockReset().mockResolvedValue(undefined);
    resetToolCallStepUp.mockReset();
    __resetScopeStepUpInFlightForTests();
  });

  it("redirects immediately when no turn is in flight", () => {
    driveChatScopeStepUp(server, challenge);
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
  });

  it("holds the redirect until the turn ends", () => {
    beginChatTurnScopeStepUpHold();
    driveChatScopeStepUp(server, challenge);
    expect(applyToolCallStepUp).not.toHaveBeenCalled();

    endChatTurnScopeStepUpHold();
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
    expect(applyToolCallStepUp).toHaveBeenCalledWith(server, {
      requiredScope: "files:write",
      resourceMetadataUrl: undefined,
    });
  });

  it("waits for persistence before redirecting", async () => {
    let persisted: (() => void) | undefined;
    const waitForPersist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          persisted = resolve;
        }),
    );

    beginChatTurnScopeStepUpHold();
    driveChatScopeStepUp(server, challenge);
    endChatTurnScopeStepUpHold(waitForPersist);

    await Promise.resolve();
    expect(waitForPersist).toHaveBeenCalledTimes(1);
    expect(applyToolCallStepUp).not.toHaveBeenCalled();

    persisted?.();
    await vi.waitFor(() => expect(applyToolCallStepUp).toHaveBeenCalledTimes(1));
  });

  it("redirects anyway when the persistence wait rejects", async () => {
    beginChatTurnScopeStepUpHold();
    driveChatScopeStepUp(server, challenge);
    endChatTurnScopeStepUpHold(() => Promise.reject(new Error("offline")));

    await vi.waitFor(() => expect(applyToolCallStepUp).toHaveBeenCalledTimes(1));
  });

  it("does not poll for persistence when nothing was queued", () => {
    const waitForPersist = vi.fn(() => Promise.resolve());
    beginChatTurnScopeStepUpHold();
    endChatTurnScopeStepUpHold(waitForPersist);
    expect(waitForPersist).not.toHaveBeenCalled();
    expect(applyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("dedupes a server across delivery channels within one turn", () => {
    beginChatTurnScopeStepUpHold();
    // The harness delivers the same 403 twice — as a stream part and as an
    // Inspector event. One redirect, not two.
    driveChatScopeStepUp(server, challenge);
    driveChatScopeStepUp(server, { requiredScope: "files:write" });
    endChatTurnScopeStepUpHold();
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
  });

  it("releases every distinct server queued during the turn", () => {
    const other = { name: "srv-2" } as unknown as ServerWithName;
    beginChatTurnScopeStepUpHold();
    driveChatScopeStepUp(server, challenge);
    driveChatScopeStepUp(other, challenge);
    expect(applyToolCallStepUp).not.toHaveBeenCalled();

    endChatTurnScopeStepUpHold();
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(2);
  });

  it("never queues an unactionable challenge or an unresolved server", () => {
    beginChatTurnScopeStepUpHold();
    // A share-link chatbox turn resolves to no server; it must stay inert
    // rather than authorize on the host's behalf after the turn.
    driveChatScopeStepUp(undefined, challenge);
    driveChatScopeStepUp(server, { errorDescription: "nope" });
    endChatTurnScopeStepUpHold();
    expect(applyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("authorizes anyway when the turn never ends", () => {
    vi.useFakeTimers();
    try {
      const stopTurn = vi.fn();
      beginChatTurnScopeStepUpHold(stopTurn);
      driveChatScopeStepUp(server, challenge);

      vi.advanceTimersByTime(14_000);
      expect(applyToolCallStepUp).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      // The stuck stream is aborted first — it would otherwise keep streaming
      // into a page the redirect is about to discard.
      expect(stopTurn).toHaveBeenCalledTimes(1);
      expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double-fire when the turn ends after the timeout", () => {
    vi.useFakeTimers();
    try {
      beginChatTurnScopeStepUpHold(vi.fn());
      driveChatScopeStepUp(server, challenge);
      vi.advanceTimersByTime(16_000);
      expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);

      endChatTurnScopeStepUpHold();
      expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an end without a matching begin", () => {
    endChatTurnScopeStepUpHold();
    expect(applyToolCallStepUp).not.toHaveBeenCalled();
    // The gate must still be open afterwards.
    driveChatScopeStepUp(server, challenge);
    expect(applyToolCallStepUp).toHaveBeenCalledTimes(1);
  });
});
