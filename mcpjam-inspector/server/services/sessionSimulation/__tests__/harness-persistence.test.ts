import { beforeEach, expect, it, vi } from "vitest";
import { failedHarnessPersist, requirePersistedHarnessTurn } from "../harness-persistence.js";
import { releaseUncommittedHarnessLane } from "../../../utils/harness/harness-session-state.js";
import { logger } from "../../../utils/logger.js";

vi.mock("../../../utils/harness/harness-session-state.js", () => ({
  releaseUncommittedHarnessLane: vi.fn(),
}));
vi.mock("../../../utils/logger.js", () => ({ logger: { error: vi.fn() } }));

const commit = {
  ownerType: "swarm-chat" as const,
  chatSessionId: "synth_run-1_host-1_0",
  leaseId: "lease-1",
  expectedStateVersion: 1,
  harnessId: "claude-code" as const,
  harnessSessionId: "hs-1",
  resumeState: {},
  computerId: "computer-1",
  runtimeFingerprint: "fp-1",
};
beforeEach(() => vi.clearAllMocks());

it("releases an unsaved lane while preserving the original turn refusal", async () => {
  const turnError = Object.assign(new Error("rate limit"), {
    errorRefusal: { code: "rate_limit" },
  });
  await expect(requirePersistedHarnessTurn({
    outcome: { outcome: "failed", failureKind: "exception" },
    commit,
    projectId: "project",
    bearer: "test-bearer",
    turnError,
  })).rejects.toBe(turnError);
  expect(releaseUncommittedHarnessLane).toHaveBeenCalledOnce();
});

it("logs a thrown save with its original error and context", () => {
  const error = new Error("cannot serialize");
  expect(failedHarnessPersist(commit)(error)).toEqual({
    outcome: "failed", failureKind: "exception",
  });
  expect(logger.error).toHaveBeenCalledWith(
    "[sessionSimulation] harness turn persist threw", error,
    { chatSessionId: commit.chatSessionId },
  );
});
