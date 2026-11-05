import { describe, expect, it, vi } from "vitest";

const loops = vi.hoisted(() => {
  const stopped: string[] = [];
  const releases: Array<() => void> = [];
  const handle = (name: string) => ({
    stop: () => {
      stopped.push(name);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  return { stopped, releases, handle };
});

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

import { startBackgroundWorkers } from "../background-workers";

describe("startBackgroundWorkers", () => {
  it("stops every loop before waiting on any one's in-flight job", async () => {
    const workers = startBackgroundWorkers();

    let finished = false;
    const stopping = workers.stop().then(() => {
      finished = true;
    });

    // A busy loop no longer holds the others' stop back: all four stopped
    // claiming while every job is still running.
    expect(loops.stopped).toEqual([
      "scheduled-evals",
      "github-checks",
      "bench",
      "production-checks",
    ]);
    await Promise.resolve();
    expect(finished).toBe(false);

    for (const release of loops.releases) release();
    await stopping;
    expect(finished).toBe(true);
  });
});
