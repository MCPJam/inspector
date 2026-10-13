import { afterEach, beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch: request }));
import { ensureLocalHarnessReady, loadStoredLocalHarnessConsent } from "../local-harness-consent";
const ready = { token: "capability-token-long-enough", expiresAt: "2099-01-01T00:00:00.000Z", target: { runtimeId: "verified" } };
beforeEach(() => { request.mockReset(); localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
it("authorizes once, polls the install, then renews readiness without another approval", async () => {
  request.mockResolvedValueOnce(Response.json({ state: "installing" }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ state: "downloading", percent: 50 }))
    .mockResolvedValueOnce(Response.json({ state: "ready" }))
    .mockResolvedValueOnce(Response.json(ready));
  const pending = ensureLocalHarnessReady("project", true);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toEqual(ready);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/mcp/local-harness/setup", "/api/mcp/local-harness/runtime/status",
    "/api/mcp/local-harness/runtime/status", "/api/mcp/local-harness/readiness",
  ]);
  expect(loadStoredLocalHarnessConsent("project")).toEqual(ready);
});
it("exposes installation failure instead of automatically looping through retries", async () => {
  request.mockResolvedValueOnce(Response.json({ state: "installing" }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ state: "failed", message: "Download failed" }));
  const rejected = expect(ensureLocalHarnessReady("project", true)).rejects.toThrow("Download failed");
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(request).toHaveBeenCalledTimes(2);
  expect(loadStoredLocalHarnessConsent("project")).toBeNull();
});
it("does not persist a late credential after changing accounts or leaving the scope", async () => {
  const abort = new AbortController();
  request.mockImplementation(async () => { abort.abort(new Error("Account changed")); return Response.json(ready); });
  await expect(ensureLocalHarnessReady("project", false, abort.signal)).rejects.toThrow("Account changed");
  expect(loadStoredLocalHarnessConsent("project")).toBeNull();
});
