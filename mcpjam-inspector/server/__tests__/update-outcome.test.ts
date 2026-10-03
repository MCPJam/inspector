import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { newAttempt } from "../../src/ipc/update/update-attempt.js";
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@sentry/electron/main", () => ({
  captureEvent: mocks.capture,
  flush: mocks.flush,
  withScope: (fn: any) => fn({ addEventProcessor: vi.fn() }),
}));
vi.mock("electron-log", () => ({ default: { warn: mocks.warn } }));
import {
  rememberInstallFailure,
  reportPendingInstallResults,
} from "../../src/ipc/update/update-outcome.js";
let directory: string;
const journal = () => path.join(directory, ".update-install-outcomes.json");
const read = () => JSON.parse(fs.readFileSync(journal(), "utf8"));
function remember(target = "3.12.8") {
  const a = newAttempt("3.12.6");
  a.targetVersion = target;
  const eventId = rememberInstallFailure(directory, a);
  return { a, eventId };
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "update-outcome-"));
  vi.clearAllMocks();
  mocks.flush.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});
it.each([
  ["3.12.8", "installed"],
  ["3.13.0", "installed"],
  ["3.12.6", "not_installed"],
  ["3.12.7", "not_installed"],
  ["3.11.0", "not_installed"],
  ["bad", "unknown"],
])("verifies %s as %s", async (version, outcome) => {
  const { a, eventId } = remember();
  await reportPendingInstallResults(directory, version);
  expect(mocks.capture).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "info",
      tags: expect.objectContaining({ update_notification: "outcome" }),
      contexts: {
        update: expect.objectContaining({
          attempt_id: a.id,
          failure_event_id: eventId,
          install_outcome: outcome,
        }),
      },
    }),
  );
  expect(read()).toEqual([]);
  await reportPendingInstallResults(directory, version);
  expect(mocks.capture).toHaveBeenCalledTimes(1);
});
it("does not report without a next launch; retry cleanup cannot delete its journal", () => {
  const { a } = remember();
  rememberInstallFailure(directory, a);
  expect(read()).toHaveLength(1);
  expect(mocks.capture).not.toHaveBeenCalled();
});
it("keeps first-launch version and event identity across offline launches", async () => {
  remember();
  mocks.flush.mockResolvedValue(false);
  await reportPendingInstallResults(directory, "3.12.6");
  const first = mocks.capture.mock.calls[0][0];
  mocks.flush.mockResolvedValue(true);
  await reportPendingInstallResults(directory, "3.12.8");
  expect(mocks.capture.mock.calls[1][0]).toEqual(first);
  expect(read()).toEqual([]);
});
it("keeps failures added while flushing", async () => {
  remember();
  mocks.flush.mockImplementation(async () => {
    remember();
    return true;
  });
  await reportPendingInstallResults(directory, "3.12.8");
  expect(read()).toHaveLength(1);
  expect(read()[0].observed).toBeUndefined();
});
it("bounds hung telemetry and retains the result", async () => {
  vi.useFakeTimers();
  remember();
  mocks.flush.mockImplementation(() => new Promise(() => {}));
  const reporting = reportPendingInstallResults(directory, "3.12.8");
  await vi.advanceTimersByTimeAsync(2000);
  await reporting;
  expect(read()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("handles missing and invalid records without fabricating results", async () => {
  await reportPendingInstallResults(directory, "3.12.8");
  fs.writeFileSync(journal(), "{bad");
  await reportPendingInstallResults(directory, "3.12.8");
  expect(
    rememberInstallFailure(directory, newAttempt("3.12.6")),
  ).toBeUndefined();
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalled();
});
it("reports unknown when the target is missing", async () => {
  rememberInstallFailure(directory, newAttempt("3.12.6"));
  await reportPendingInstallResults(directory, "3.12.8");
  expect(mocks.capture.mock.calls[0][0].contexts.update.install_outcome).toBe(
    "unknown",
  );
});
it("preserves the journal on storage failure", async () => {
  remember();
  const previous = read();
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("disk full");
  });
  await reportPendingInstallResults(directory, "3.12.8");
  expect(read()).toEqual(previous);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalled();
});
