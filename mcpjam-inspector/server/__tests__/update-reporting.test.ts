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
vi.mock("electron-log", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
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

it("reports recovery with safe timing and intent metadata, deduplicated separately", () => {
  const attempt = newAttempt("3.11.0");
  attempt.downloadRetries = 2;
  attempt.downloadRequested = true;
  attempt.activeDownloadMs = 1000;
  attempt.sleepMs = 2000;
  attempt.offlineMs = 3000;
  reportUpdateFailure(attempt, "download_recovered");
  reportUpdateFailure(attempt, "download_recovered");
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  expect(mocks.capture.mock.calls[0][0]).toMatchObject({
    level: "info",
    contexts: {
      update: {
        download_retries: 2,
        user_requested: false,
        download_requested: true,
        active_download_ms: 1000,
        sleep_ms: 2000,
        offline_ms: 3000,
      },
    },
  });
  const sanitized = mocks.processors[0]({
    user: { email: "private" },
    breadcrumbs: [{ message: "private" }],
    extra: { token: "private" },
    request: { url: "private" },
  });
  expect(JSON.stringify(sanitized)).not.toContain("private");
});
