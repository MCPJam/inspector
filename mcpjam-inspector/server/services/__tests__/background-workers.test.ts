import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loops = vi.hoisted(() => {
  const started: string[] = [];
  const stopped: string[] = [];
  const releases: Array<() => void> = [];
  const handle = (name: string) => {
    started.push(name);
    return {
      stop: () => {
        stopped.push(name);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    };
  };
  return { started, stopped, releases, handle };
});
const { events } = vi.hoisted(() => ({ events: vi.fn() }));

vi.mock("../scheduled-evals-worker", () => ({
  isScheduledEvalsWorkerEnabled: () => true,
  startScheduledEvalsWorker: () => loops.handle("scheduled-evals"),
}));
vi.mock("../github-checks-worker", () => ({
  isGithubChecksWorkerEnabled: () => true,
  startGithubChecksWorker: () => loops.handle("github-checks"),
}));
vi.mock("../bench-worker", () => ({
  isBenchWorkerEnabled: () => true,
  startBenchWorker: () => loops.handle("bench"),
}));
vi.mock("../production-checks-worker", () => ({
  startProductionChecksWorker: () => loops.handle("production-checks"),
}));
vi.mock("../../utils/request-logger", () => ({
  getSystemLogger: () => ({ event: events }),
}));

import { startBackgroundWorkers } from "../background-workers";

const ALL_LOOPS = [
  "scheduled-evals",
  "github-checks",
  "bench",
  "production-checks",
];

beforeEach(() => {
  loops.started.length = 0;
  loops.stopped.length = 0;
  loops.releases.length = 0;
  events.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startBackgroundWorkers", () => {
  it("stops every loop before waiting on any one's in-flight job", async () => {
    const workers = startBackgroundWorkers();

    let finished = false;
    const stopping = workers.stop().then(() => {
      finished = true;
    });

    // A busy loop no longer holds the others' stop back: all four stopped
    // claiming while every job is still running.
    expect(loops.stopped).toEqual(ALL_LOOPS);
    await Promise.resolve();
    expect(finished).toBe(false);

    for (const release of loops.releases) release();
    await stopping;
    expect(finished).toBe(true);
  });

  it("starts no loop on a web replica, the flagless production one included", async () => {
    const workers = startBackgroundWorkers("web");

    expect(loops.started).toEqual([]);
    expect(events).toHaveBeenCalledWith("server.process_role", { role: "web" });
    await expect(workers.stop()).resolves.toBeUndefined();
  });

  it("starts every loop on a worker that can run what it claims", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");

    startBackgroundWorkers("worker");

    expect(loops.started).toEqual(ALL_LOOPS);
    expect(events).toHaveBeenCalledWith("server.process_role", {
      role: "worker",
    });
  });

  it("fails a worker's boot before any loop claims when it cannot", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    expect(() => startBackgroundWorkers("worker")).toThrow(
      /MCPJAM_PROCESS_ROLE=worker needs CONVEX_HTTP_URL, INSPECTOR_SERVICE_TOKEN/,
    );
    expect(loops.started).toEqual([]);
  });
});
