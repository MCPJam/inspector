import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopDiagnostics } from "./desktop-diagnostics";
import { parseDesktopActivity } from "../shared/desktop-diagnostics";
const exit = {
  type: "Utility",
  serviceName: "proxy_resolver.mojom.ProxyResolverFactory",
  reason: "killed",
  exitCode: 9,
};
function setup() {
  const publish = vi.fn(),
    report = vi.fn();
  const collector = createDesktopDiagnostics({ publish, report, runId: "run" });
  return { ...collector, publish, report };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
afterEach(() => vi.useRealTimers());
describe("proxy diagnostics", () => {
  it("keeps sanitized bounded history and expires stale context", () => {
    const d = setup();
    for (let i = 0; i < 80; i++)
      d.record({
        kind: "auth",
        phase: "state",
        auth: "guest",
        token: "secret",
      });
    expect(d.snapshot().activity).toHaveLength(50);
    expect(JSON.stringify(d.snapshot())).not.toContain("secret");
    vi.advanceTimersByTime(31000);
    expect(d.snapshot().renderer_context_stale).toBe(true);
    vi.advanceTimersByTime(120000);
    expect(d.snapshot().activity).toHaveLength(0);
  });
  it("links a native event and reports later success without losing failures", () => {
    const d = setup();
    d.record({ kind: "oauth_callback", phase: "start" });
    d.childExit(exit);
    const event = {
      event_id: "native-id",
      platform: "native",
      contexts: {
        desktop_diagnostics: d.snapshot(),
        electron: { details: exit },
      },
    };
    d.nativeEvent(event);
    d.record({
      kind: "connect",
      phase: "failure",
      status: 403,
      error: "access_denied",
    });
    d.record({ kind: "auth", phase: "state", auth: "guest" });
    d.record({ kind: "reconnect", phase: "success" });
    vi.advanceTimersByTime(60000);
    expect(d.report).toHaveBeenCalledTimes(1);
    expect(d.report.mock.calls[0][0]).toMatchObject({
      native_event_ids: ["native-id"],
      outcome: "connection_succeeded_afterward",
      successes: 1,
      failures: 1,
      observation: "complete",
    });
  });
  it("does not correlate another run or utility", () => {
    const d = setup();
    d.childExit(exit);
    d.nativeEvent({
      event_id: "old",
      platform: "native",
      contexts: {
        desktop_diagnostics: { run_id: "old-run" },
        electron: { details: exit },
      },
    });
    d.nativeEvent({
      event_id: "other",
      platform: "native",
      contexts: {
        desktop_diagnostics: d.snapshot(),
        electron: { details: { ...exit, serviceName: "other" } },
      },
    });
    vi.advanceTimersByTime(60000);
    expect(d.report.mock.calls[0][0].native_event_ids).toEqual([]);
    expect(d.report.mock.calls[0][0].outcome).toBe("no_connection_observed");
  });
  it("records failed connections, renderer loss, and interrupted observation", () => {
    const d = setup();
    d.childExit(exit);
    d.record({ kind: "connect", phase: "failure" });
    d.rendererGone(true);
    d.finish(true);
    expect(d.report.mock.calls[0][0]).toMatchObject({
      outcome: "connections_failed_afterward",
      renderer_exits: 1,
      observation: "interrupted",
      auth: "unknown",
      renderer_context_stale: true,
    });
    vi.advanceTimersByTime(60000);
    expect(d.report).toHaveBeenCalledTimes(1);
  });
  it("ignores ordinary exits, combines repeats, and caps reports", () => {
    const d = setup();
    d.childExit({ ...exit, reason: "clean-exit" });
    d.childExit({ ...exit, serviceName: "other" });
    vi.advanceTimersByTime(60000);
    expect(d.report).not.toHaveBeenCalled();
    for (let i = 0; i < 7; i++) {
      d.childExit(exit);
      d.childExit(exit);
      vi.advanceTimersByTime(60000);
    }
    expect(d.report).toHaveBeenCalledTimes(5);
    expect(d.report.mock.calls[0][0].exits).toBe(2);
  });
  it("never throws when reporting is unavailable", () => {
    const d = createDesktopDiagnostics({
      publish: () => {
        throw Error();
      },
      report: () => {
        throw Error();
      },
    });
    expect(() => {
      d.record({ kind: "auth", phase: "state" });
      d.childExit(exit);
      d.finish();
    }).not.toThrow();
  });
  it("rejects unbounded or secret-bearing fields", () => {
    expect(
      parseDesktopActivity({
        kind: "connect",
        phase: "failure",
        error: "secret",
      }),
    ).toBeNull();
    expect(
      parseDesktopActivity({ kind: "auth", phase: "state", version: "secret" }),
    ).toBeNull();
    expect(
      parseDesktopActivity({
        kind: "connect",
        phase: "start",
        operationId: "token",
      }),
    ).toBeNull();
    expect(
      parseDesktopActivity({ kind: "connect", phase: "failure", status: 999 }),
    ).toBeNull();
  });
  it("does not label a legacy startup minidump with current activity", () => {
    const d = setup();
    const event = {
      platform: "native",
      contexts: { desktop_diagnostics: d.snapshot() },
      tags: { desktop_run_id: d.runId },
    };
    d.nativeEvent(event);
    expect(event.contexts).not.toHaveProperty("desktop_diagnostics");
    expect(event.tags).not.toHaveProperty("desktop_run_id");
  });
});
