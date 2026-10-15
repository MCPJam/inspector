import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionLaunchHealth } from "../extension-launch-health";
vi.mock("../analytics", () => ({ track: vi.fn() }));
afterEach(() => vi.useRealTimers());
describe("logical extension launch health", () => {
  it("deduplicates retries, readiness callbacks and cached reopen by original operation", () => {
    const emit = vi.fn();
    const registry = new ExtensionLaunchHealth(emit);
    const first = registry.begin("private-operation", "thread", "chatgpt");
    expect(registry.begin("private-operation", "global", "codex")).toBe(first);
    first.awaitingReadiness();
    first.ready();
    first.ready();
    first.fail("rendering");
    registry.begin("private-operation", "thread", "chatgpt").ready();
    expect(emit.mock.calls).toEqual([
      [
        {
          launch_kind: "thread",
          host_profile: "chatgpt",
          outcome: "success",
          failure_stage: "none",
        },
      ],
    ]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private-operation");
  });
  it.each(["execution", "rendering", "timeout", "unknown"] as const)(
    "counts %s once",
    (stage) => {
      const emit = vi.fn();
      const registry = new ExtensionLaunchHealth(emit);
      registry.begin("op", "global", "codex").fail(stage);
      registry.begin("op", "global", "codex").ready();
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0][0].failure_stage).toBe(stage);
    },
  );
  it.each(["deliberate cancellation", "expected denial"])(
    "excludes %s from numerator and denominator",
    () => {
      const emit = vi.fn();
      const registry = new ExtensionLaunchHealth(emit);
      const observation = registry.begin("op", "file", "chatgpt");
      observation.exclude();
      observation.ready();
      observation.fail("unknown");
      expect(emit).not.toHaveBeenCalled();
    },
  );
  it("times initial readiness only and does not reset timeout on retry or hide", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const registry = new ExtensionLaunchHealth(emit, 100);
    const observation = registry.begin("op", "settings", "codex");
    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();
    observation.awaitingReadiness();
    vi.advanceTimersByTime(99);
    observation.awaitingReadiness();
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit.mock.calls[0][0].failure_stage).toBe("timeout");
    observation.ready();
    expect(emit).toHaveBeenCalledOnce();
  });
  it("clears readiness timers on completion, denial and owner cancellation", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const registry = new ExtensionLaunchHealth(emit, 100);
    for (const id of ["success", "denial", "cancel"])
      registry.begin(id, "thread", "chatgpt").awaitingReadiness();
    registry.begin("success", "thread", "chatgpt").ready();
    registry.begin("denial", "thread", "chatgpt").exclude();
    registry.dispose();
    vi.runAllTimers();
    expect(emit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    registry.begin("late", "thread", "chatgpt").ready();
    expect(emit).toHaveBeenCalledOnce();
  });
  it("records uncertain teardown without replaying a successful launch", () => {
    const emit = vi.fn();
    const registry = new ExtensionLaunchHealth(emit);
    registry.begin("success", "thread", "chatgpt").ready();
    registry.begin("pending", "thread", "chatgpt");
    registry.dispose("unknown");
    expect(emit.mock.calls.map((call) => call[0].failure_stage)).toEqual([
      "none",
      "unknown",
    ]);
  });
  it("does not evict completed tombstones when full or let analytics throw into UI", () => {
    const emit = vi.fn(() => {
      throw new Error("offline");
    });
    const registry = new ExtensionLaunchHealth(emit, 100, 1);
    expect(() =>
      registry.begin("first", "thread", "chatgpt").ready(),
    ).not.toThrow();
    registry.begin("second", "thread", "chatgpt").ready();
    registry.begin("first", "thread", "chatgpt").ready();
    expect(emit).toHaveBeenCalledOnce();
  });
});
