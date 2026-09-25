import { afterEach, describe, expect, it, vi } from "vitest";
import { newAttempt } from "../../src/ipc/update/update-attempt.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  processors: [] as Array<(event: any) => any>,
  flush: vi.fn(),
}));
vi.mock("@sentry/electron/main", () => ({
  captureEvent: mocks.capture,
  flush: mocks.flush,
  withScope: (callback: (scope: any) => void) =>
    callback({ addEventProcessor: (fn: any) => mocks.processors.push(fn) }),
}));
vi.mock("electron-log", () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
import {
  flushUpdateReports,
  reportUpdateFailure,
} from "../../src/ipc/update/update-reporting.js";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.processors.length = 0;
});

describe("update failure reporting", () => {
  it("deduplicates repeated failures but records a failed recovery separately", () => {
    const attempt = newAttempt("3.10.0");
    reportUpdateFailure(attempt, "updater_error");
    reportUpdateFailure(attempt, "updater_error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    attempt.retries = 1;
    reportUpdateFailure(attempt, "updater_error");
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
  it("removes inherited OAuth breadcrumbs, identity and extra data after scope merging", () => {
    reportUpdateFailure(newAttempt("3.10.0"), "updater_error");
    const raw = {
      ...mocks.capture.mock.calls[0][0],
      user: { email: "private" },
      request: { url: "private" },
      breadcrumbs: [{ message: "private" }],
      extra: { token: "private" },
    };
    const event = mocks.processors[0](raw);
    expect(JSON.stringify(event)).not.toContain("private");
    expect(event.tags).toMatchObject({
      component: "desktop-updater",
      update_reason: "updater_error",
    });
  });
  it("keeps deduplication across serialization", () => {
    const attempt = newAttempt("3.10.0");
    reportUpdateFailure(attempt, "install_threw");
    reportUpdateFailure(JSON.parse(JSON.stringify(attempt)), "install_threw");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
  it("bounds a never-ending flush", async () => {
    vi.useFakeTimers();
    mocks.flush.mockImplementation(() => new Promise(() => {}));
    const done = vi.fn();
    const promise = flushUpdateReports().then(done);
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
