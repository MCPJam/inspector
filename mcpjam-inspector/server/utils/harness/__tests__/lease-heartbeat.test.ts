import { afterEach, expect, it, vi } from "vitest";
vi.mock("../harness-session-state.js", () => ({ heartbeatHarnessSessionState: vi.fn(async () => "ok") }));
import { heartbeatHarnessSessionState } from "../harness-session-state.js";
import { startLeaseHeartbeat } from "../lease-heartbeat.js";
import type { HarnessOwnerRef } from "../harness-session-state.js";
const owner: HarnessOwnerRef = { ownerType: "direct-chat", projectId: "project", chatSessionId: "chat", harnessId: "codex" };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it("allows one authorization lookup at a time and fences a late result after stop", async () => {
  vi.useFakeTimers(); let resolve!: (value: string) => void;
  const getAuthorization = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
  const onLost = vi.fn();
  const stop = startLeaseHeartbeat({ owner, leaseId: "lease", leaseTtlMs: 300_000, intervalMs: 90_000, timeoutMs: 10_000, getAuthorization, onLost });
  await vi.advanceTimersByTimeAsync(270_000); expect(getAuthorization).toHaveBeenCalledOnce();
  stop(); resolve("Bearer refreshed"); await Promise.resolve(); await Promise.resolve();
  expect(heartbeatHarnessSessionState).not.toHaveBeenCalled(); expect(onLost).not.toHaveBeenCalled();
});
it("treats revoked authorization as lost without sending a stale token", async () => {
  vi.useFakeTimers(); const onLost = vi.fn();
  const stop = startLeaseHeartbeat({ owner, leaseId: "lease", leaseTtlMs: 300_000, intervalMs: 90_000, timeoutMs: 10_000,
    getAuthorization: async () => { throw new Error("revoked"); }, onLost });
  await vi.advanceTimersByTimeAsync(90_000); stop();
  expect(onLost).toHaveBeenCalledOnce(); expect(heartbeatHarnessSessionState).not.toHaveBeenCalled();
});
