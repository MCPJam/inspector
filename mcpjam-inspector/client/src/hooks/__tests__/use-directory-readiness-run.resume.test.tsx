/**
 * A run whose node stopped is re-queued and waits for the person who started
 * it. The hook resumes it once per re-queue while it polls, and keeps polling
 * whatever the resume answers.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@/lib/apis/directory-readiness-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/directory-readiness-api")
  >("@/lib/apis/directory-readiness-api");
  return {
    ...actual,
    getHostedReadinessRun: api.getRun,
    resumeHostedReadinessRun: api.resume,
  };
});
vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => true }));

import { useDirectoryReadinessRun } from "../use-directory-readiness-run";

const SERVER = {
  name: "Sample server",
  config: { url: "https://mcp.example.com/mcp" },
};

function runRow(status: string, attemptCount = 1, resumable = false) {
  return { id: "run_1", status, attemptCount, resumable, updatedAt: 1 };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function watchRun() {
  const start = vi.fn();
  const hook = renderHook(() =>
    useDirectoryReadinessRun({ publisher: "claude", server: SERVER, start }),
  );
  act(() => hook.result.current.watch("run_1"));
  return hook;
}

describe("useDirectoryReadinessRun with a re-queued run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(api)) mock.mockReset();
    api.resume.mockResolvedValue({ runId: "run_1", status: "running" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes it once, then keeps polling to the end", async () => {
    api.getRun
      .mockResolvedValueOnce(runRow("pending", 2, true))
      // A read from before the resume landed: not a second resume.
      .mockResolvedValueOnce(runRow("pending", 2, true))
      .mockResolvedValueOnce(runRow("running", 2))
      .mockResolvedValueOnce(runRow("completed", 2));
    const { result } = watchRun();

    await settle();
    expect(api.resume).toHaveBeenCalledTimes(1);
    expect(api.resume).toHaveBeenCalledWith("run_1");

    for (let poll = 0; poll < 3; poll += 1) await settle(2_500);
    expect(api.resume).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.run?.status).toBe("completed");
  });

  it("resumes again only when the run is re-queued again", async () => {
    api.getRun
      .mockResolvedValueOnce(runRow("pending", 2, true))
      .mockResolvedValueOnce(runRow("pending", 3, true))
      .mockResolvedValueOnce(runRow("completed", 3));
    watchRun();

    await settle();
    await settle(2_500);
    await settle(2_500);
    expect(api.resume).toHaveBeenCalledTimes(2);
  });

  it("keeps polling when the resume is refused", async () => {
    // Somebody else's run: the backend refuses, and the run's own status is
    // what the page goes on showing.
    api.resume.mockRejectedValue(new Error("No readiness run you can resume"));
    api.getRun
      .mockResolvedValueOnce(runRow("pending", 2, true))
      .mockResolvedValueOnce(runRow("failed", 2));
    const { result } = watchRun();

    await settle();
    expect(result.current.state.status).toBe("running");
    await settle(2_500);
    expect(api.resume).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.error).toBeUndefined();
  });

  it("never resumes a run that is not waiting", async () => {
    api.getRun
      .mockResolvedValueOnce(runRow("running"))
      .mockResolvedValueOnce(runRow("completed"));
    watchRun();
    await settle();
    await settle(2_500);
    expect(api.resume).not.toHaveBeenCalled();
  });
});
