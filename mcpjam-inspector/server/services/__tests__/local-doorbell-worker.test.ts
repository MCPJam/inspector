import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ logger: log }));
// The real passes call the backend; these tests inject their own.
vi.mock("../../routes/internal/agent-turns.js", () => ({
  runDurableAgentPass: vi.fn(),
}));
vi.mock("../chat-stage/chat-session-stage-pass.js", () => ({
  runChatSessionStagePass: vi.fn(),
}));

import {
  localDoorbellIntervalMs,
  startLocalDoorbell,
  type DoorbellPass,
} from "../local-doorbell-worker";
import { createDrainCoordinator } from "../lifecycle/drain";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("localDoorbellIntervalMs", () => {
  it("is off unless set to a whole number of at least a second", () => {
    expect(localDoorbellIntervalMs(undefined)).toBeNull();
    expect(localDoorbellIntervalMs("")).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();

    expect(localDoorbellIntervalMs("3000")).toBe(3000);
    for (const bad of ["500", "1.5e3x", "abc", "1500.5"]) {
      expect(localDoorbellIntervalMs(bad)).toBeNull();
    }
    expect(log.warn).toHaveBeenCalledTimes(4);
  });
});

describe("startLocalDoorbell", () => {
  it("runs each pass in turn on every ring, until stopped", async () => {
    const order: string[] = [];
    const passes: DoorbellPass[] = [
      { name: "agent-turns", run: async () => void order.push("agent-turns") },
      { name: "chat-stage", run: async () => void order.push("chat-stage") },
    ];
    const handle = startLocalDoorbell(5, {
      passes,
      drain: createDrainCoordinator(),
    });
    await tick();
    await handle.stop();

    expect(order.slice(0, 4)).toEqual([
      "agent-turns",
      "chat-stage",
      "agent-turns",
      "chat-stage",
    ]);
    const rings = order.length;
    await tick();
    expect(order.length).toBe(rings);
  });

  it("rings nothing while the server drains", async () => {
    const run = vi.fn(async () => {});
    const drain = createDrainCoordinator();
    drain.begin();
    const handle = startLocalDoorbell(5, {
      passes: [{ name: "agent-turns", run }],
      drain,
    });
    await tick();
    await handle.stop();
    expect(run).not.toHaveBeenCalled();
  });

  it("logs a repeated failure once, keeps ringing the other passes, and notes recovery", async () => {
    let failing = true;
    const healthy = vi.fn(async () => {});
    const handle = startLocalDoorbell(5, {
      passes: [
        {
          name: "agent-turns",
          run: async () => {
            if (failing) throw new Error("Agent worker claim failed (404).");
          },
        },
        { name: "chat-stage", run: healthy },
      ],
      drain: createDrainCoordinator(),
    });
    await tick();
    failing = false;
    await tick();
    await handle.stop();

    const failures = log.warn.mock.calls.filter(([message]) =>
      String(message).includes("agent-turns pass failed"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][1]).toEqual({
      error: "Agent worker claim failed (404).",
    });
    expect(healthy.mock.calls.length).toBeGreaterThan(1);
    expect(log.info).toHaveBeenCalledWith(
      "[local-doorbell] agent-turns pass recovered",
    );
  });
});
