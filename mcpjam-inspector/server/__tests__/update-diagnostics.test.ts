import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
import log from "electron-log";
import {
  UpdateDiagnostics,
  safeUpdateError,
} from "../../src/ipc/update/update-diagnostics.js";
let dir: string;
let d: UpdateDiagnostics;
let online: boolean;
let id: string;
const file = () => path.join(dir, "diagnostics.json");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-diagnostics-"));
  online = true;
  id = randomUUID();
  d = new UpdateDiagnostics(file(), () => online);
});
afterEach(() => {
  d.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});
it("retains timing after timeout, including offline and sleep, without extra update calls", () => {
  d.record(id, "attempt_started", { trigger: "startup" });
  d.watch(id);
  vi.advanceTimersByTime(20 * 60_000);
  d.record(id, "download_timeout");
  d.power(true);
  vi.advanceTimersByTime(2 * 60 * 60_000);
  d.power(false);
  online = false;
  vi.advanceTimersByTime(60_000);
  online = true;
  vi.advanceTimersByTime(30_000);
  d.stop();
  d.record(id, "download_completed");
  expect(d.snapshot(id)).toMatchObject({
    observed_ms: 1_200_000,
    sleep_ms: 7_200_000,
    offline_ms: 90_000,
    after_timeout_ms: 7_290_000,
    byte_progress: "unavailable",
  });
  expect(vi.getTimerCount()).toBe(0);
});
it("marks cross-process gaps unknown and preserves the attempt start", () => {
  d.record(id, "attempt_started", { trigger: "scheduled" });
  d.watch(id);
  vi.advanceTimersByTime(30_000);
  d.stop();
  vi.advanceTimersByTime(90_000);
  d = new UpdateDiagnostics(file());
  d.record(id, "launch_verification", { result: "installed" });
  expect(d.snapshot(id)).toMatchObject({
    started_at: 1_000_000,
    observed_ms: 30_000,
    unknown_ms: 90_000,
  });
  expect((d.snapshot(id).timeline as any[]).map((e) => e.step)).toContain(
    "process_gap",
  );
});
it("does not count an unexplained event-loop gap as active downloading", () => {
  d.record(id, "attempt_started");
  d.watch(id);
  vi.setSystemTime(5_000_000);
  d.stop();
  expect(d.snapshot(id)).toMatchObject({
    observed_ms: 0,
    unknown_ms: 4_000_000,
  });
});
it("preserves first-class timestamps when the 100-transition timeline rolls over", () => {
  d.record(id, "attempt_started", { trigger: "startup" });
  for (let i = 0; i < 120; i++) {
    vi.advanceTimersByTime(1);
    d.record(id, "check_requested", { trigger: "automatic_retry" });
  }
  expect(d.snapshot(id).timeline).toHaveLength(100);
  expect(d.snapshot(id).timestamps).toMatchObject({
    attempt_started: 1_000_000,
  });
  expect(fs.existsSync(file() + ".tmp")).toBe(false);
});
it("limits persisted attempts to 32", () => {
  for (let i = 0; i < 40; i++) d.record(randomUUID(), "attempt_started");
  expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toHaveLength(32);
});
it("old attempts have unknown start, not an invented start timestamp", () => {
  expect(d.snapshot(id)).toMatchObject({
    history: "partial",
    started_at: null,
    attempt_elapsed_ms: null,
  });
});
it.each(["{broken", "{}", '[{"id":"invalid"}]'])(
  "handles invalid journal %s without affecting updates",
  (contents) => {
    fs.writeFileSync(file(), contents);
    d = new UpdateDiagnostics(file());
    expect(() => d.record(id, "attempt_started")).not.toThrow();
    expect(d.snapshot(id).history).toBe("recorded");
  },
);
it("storage failures leave useful in-memory diagnostics", () => {
  d = new UpdateDiagnostics(path.join(dir, "missing", "journal"));
  d.record(id, "attempt_started");
  d.record(
    id,
    "native_error",
    safeUpdateError({ code: "ENOSPC", message: "secret" }),
  );
  expect(d.snapshot(id).timeline).toHaveLength(2);
});
it("strips unknown journal fields and native error text", () => {
  d.record(
    id,
    "native_error",
    safeUpdateError({
      code: "ETIMEDOUT",
      domain: "NSURLErrorDomain",
      message: "secret URL",
      path: "secret path",
    }),
  );
  const rows = JSON.parse(fs.readFileSync(file(), "utf8"));
  rows[0].secret = "private";
  rows[0].timeline[0].message = "private";
  fs.writeFileSync(file(), JSON.stringify(rows));
  d = new UpdateDiagnostics(file());
  const snapshot = d.snapshot(id);
  expect(JSON.stringify(snapshot)).not.toMatch(/secret|private/);
  expect((snapshot.timeline as any[])[0]).toMatchObject({
    category: "network",
    code: "ETIMEDOUT",
  });
  expect(
    safeUpdateError({ code: "secret", domain: "private", message: "password" }),
  ).toEqual({ category: "unknown" });
});
it("survives logging failures and throwing native error getters", () => {
  vi.mocked(log.info).mockImplementation(() => {
    throw new Error("disk");
  });
  expect(() => d.record(id, "download_completed")).not.toThrow();
  expect(
    safeUpdateError({
      get code() {
        throw new Error();
      },
    }),
  ).toEqual({ category: "unknown" });
});
it("never treats persisted diagnostics as update permission", () => {
  d.record(id, "restart_requested", { trigger: "user_retry" });
  expect(
    Object.keys(JSON.parse(fs.readFileSync(file(), "utf8"))[0]),
  ).not.toContain("userRequested");
});
