import { describe, expect, it, vi } from "vitest";
import { cancelEvalRunForAgent } from "../agent-cancel-eval-run";

function handlers(cancellingRunId: string | null = null) {
  return {
    cancellingRunId,
    handleCancelRun: vi.fn(async (_runId: string) => {}),
  };
}

describe("cancelEvalRunForAgent", () => {
  it.each(["pending", "running", "grading"])(
    "cancels a %s run through the Cancel button's handler",
    async (status) => {
      const h = handlers();

      const result = await cancelEvalRunForAgent({ _id: "run-1", status }, h);

      expect(result).toEqual({ status: "cancel_requested", runId: "run-1" });
      expect(h.handleCancelRun).toHaveBeenCalledWith("run-1");
    },
  );

  it.each(["completed", "failed", "cancelled", "timed_out"])(
    "reports a %s run as already finished and cancels nothing",
    async (status) => {
      const h = handlers();

      const result = await cancelEvalRunForAgent({ _id: "run-1", status }, h);

      expect(result).toEqual({
        status: "already_finished",
        runId: "run-1",
        runStatus: status,
      });
      expect(h.handleCancelRun).not.toHaveBeenCalled();
    },
  );

  it("refuses while another cancellation is in flight", async () => {
    const h = handlers("run-other");

    await expect(
      cancelEvalRunForAgent({ _id: "run-1", status: "grading" }, h),
    ).rejects.toThrow("Another run cancellation is already in progress.");
    expect(h.handleCancelRun).not.toHaveBeenCalled();
  });
});
