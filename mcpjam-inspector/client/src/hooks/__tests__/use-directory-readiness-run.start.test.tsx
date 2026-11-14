/**
 * The readiness run hook driven by another route's start, as the Readiness
 * page drives it for a directory submission: always hosted, polled on the
 * same ladder, and with no report fetched, because that page reads results
 * placed on its own form. `watch` follows a run the page did not start.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  runLocal: vi.fn(),
  startHosted: vi.fn(),
  getRun: vi.fn(),
  getReport: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/apis/directory-readiness-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/directory-readiness-api")
  >("@/lib/apis/directory-readiness-api");
  return {
    ...actual,
    runLocalReadiness: api.runLocal,
    startHostedReadiness: api.startHosted,
    getHostedReadinessRun: api.getRun,
    getHostedReadinessReport: api.getReport,
    cancelHostedReadinessRun: api.cancel,
  };
});
// A local build: without `start`, the hook would grade locally.
vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => false }));

import { useDirectoryReadinessRun } from "../use-directory-readiness-run";

const SERVER = {
  name: "Sample server",
  config: { url: "https://mcp.example.com/mcp" },
};

function runRow(id: string, status: string) {
  return { id, status, hasReport: true, updatedAt: 1 };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useDirectoryReadinessRun with a start of its own", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(api)) mock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts through it, polls the run, and fetches no report", async () => {
    const start = vi.fn().mockResolvedValue({ runId: "run_1" });
    api.getRun
      .mockResolvedValueOnce(runRow("run_1", "running"))
      .mockResolvedValueOnce(runRow("run_1", "completed"));
    const { result } = renderHook(() =>
      useDirectoryReadinessRun({ publisher: "claude", server: SERVER, start }),
    );

    await act(async () => {
      await result.current.run();
    });
    expect(start).toHaveBeenCalledWith(expect.stringMatching(/^ui-claude-/));
    expect(api.runLocal).not.toHaveBeenCalled();
    expect(api.startHosted).not.toHaveBeenCalled();
    await settle();
    expect(result.current.state.status).toBe("running");

    await settle(2_500);
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.run?.status).toBe("completed");
    expect(api.getReport).not.toHaveBeenCalled();
  });

  it("cancels a run it started through the hosted route, as it ran it", async () => {
    const start = vi.fn().mockResolvedValue({ runId: "run_1" });
    api.getRun.mockResolvedValue(runRow("run_1", "running"));
    api.cancel.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirectoryReadinessRun({ publisher: "claude", server: SERVER, start }),
    );
    await act(async () => {
      await result.current.run();
    });
    await settle();

    await act(async () => {
      await result.current.cancel();
    });
    expect(api.cancel).toHaveBeenCalledWith("run_1");
    // The run row stays on screen until its poll reports the real end.
    expect(result.current.state.run?.id).toBe("run_1");
  });

  it("follows a run it did not start, once", async () => {
    api.getRun.mockResolvedValue(runRow("run_2", "completed"));
    const start = vi.fn();
    const { result } = renderHook(() =>
      useDirectoryReadinessRun({ publisher: "claude", server: SERVER, start }),
    );

    act(() => result.current.watch("run_2"));
    act(() => result.current.watch("run_2"));
    await settle();
    expect(api.getRun).toHaveBeenCalledTimes(1);
    expect(api.getRun).toHaveBeenCalledWith("run_2");
    expect(result.current.state.run?.id).toBe("run_2");
  });
});
