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

import { PlatformApiError } from "@mcpjam/sdk/platform";
import { useDirectoryReadinessRun } from "../use-directory-readiness-run";

function refusal(status: number, message: string) {
  return new PlatformApiError(message, "FORBIDDEN", { status });
}

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
    api.resume.mockRejectedValue(
      refusal(403, "No readiness run you can resume was found."),
    );
    api.getRun
      // Still marked resumable on the next read: a refusal is not asked again.
      .mockResolvedValueOnce(runRow("pending", 2, true))
      .mockResolvedValueOnce(runRow("pending", 2, true))
      .mockResolvedValueOnce(runRow("failed", 2));
    const { result } = watchRun();

    await settle();
    expect(result.current.state.status).toBe("running");
    await settle(2_500);
    await settle(2_500);
    expect(api.resume).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.error).toBeUndefined();
  });

  it("tries a resume that failed for a transient reason again, at most three times", async () => {
    api.resume.mockRejectedValue(
      refusal(502, "Failed to reach authorization service."),
    );
    api.getRun.mockResolvedValue(runRow("pending", 2, true));
    watchRun();

    await settle();
    for (let poll = 0; poll < 5; poll += 1) await settle(2_500);
    expect(api.resume).toHaveBeenCalledTimes(3);
  });

  it("stops trying once a retried resume goes through", async () => {
    api.resume
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ runId: "run_1", status: "running" });
    api.getRun.mockResolvedValue(runRow("pending", 2, true));
    watchRun();

    await settle();
    for (let poll = 0; poll < 3; poll += 1) await settle(2_500);
    expect(api.resume).toHaveBeenCalledTimes(2);
  });

  it("sends one resume while another poll reads the run", async () => {
    let finish: (value: unknown) => void = () => undefined;
    api.resume.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    api.getRun.mockResolvedValue(runRow("pending", 2, true));
    watchRun();
    await settle();

    // The tab comes back while the first resume is still out.
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(api.resume).toHaveBeenCalledTimes(1);
    finish({ runId: "run_1", status: "running" });
    await settle();
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
