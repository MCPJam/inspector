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
  driveScopeStepUpFromChallenge,
  driveScopeStepUpFromError,
  resetScopeStepUp,
  runWithScopeStepUp,
} from "../scope-step-up";
import { McpRequestError } from "@/lib/apis/insufficient-scope";
import type { ServerWithName } from "@/state/app-types";

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
});
