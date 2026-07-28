/**
 * The task-creation fan-out (`src/mcp-client-manager/task-created-event.ts`).
 *
 * The rule under test is the asymmetry: durable tracking and client delivery
 * are FUNCTIONAL paths whose failure must surface, while the hosted registry
 * is a recovery index whose failure must never turn a successful tool call
 * into a failed one.
 */

import { describe, expect, it, vi } from "vitest";
import {
  TaskCreatedSink,
  type TaskCreatedEvent,
} from "../src/mcp-client-manager/task-created-event.js";

const event: TaskCreatedEvent = {
  identity: { serverId: "srv", wire: "extension", taskId: "t1" },
  wire: "extension",
  surface: "chat",
  createdAt: "2026-07-28T00:00:00Z",
  ttlMs: null,
  toolName: "long_running",
};

describe("fan-out", () => {
  it("delivers to every consumer, in registration order", async () => {
    const order: string[] = [];
    const sink = new TaskCreatedSink();
    sink.register({ name: "tracker", handle: () => void order.push("tracker") });
    sink.register({ name: "stream", handle: () => void order.push("stream") });
    sink.register({
      name: "registry",
      bestEffort: true,
      handle: () => void order.push("registry"),
    });

    await sink.dispatch(event);
    // Durable local tracking lands before anything remote, so a hung registry
    // write cannot cost the user their handle.
    expect(order).toEqual(["tracker", "stream", "registry"]);
  });

  it("awaits async consumers rather than firing and forgetting", async () => {
    let done = false;
    const sink = new TaskCreatedSink();
    sink.register({
      name: "tracker",
      handle: async () => {
        await Promise.resolve();
        done = true;
      },
    });
    await sink.dispatch(event);
    expect(done).toBe(true);
  });

  it("passes the handle through unchanged", async () => {
    const spy = vi.fn();
    const sink = new TaskCreatedSink();
    sink.register({ name: "analytics", handle: spy });
    await sink.dispatch(event);
    expect(spy).toHaveBeenCalledWith(event);
  });

  it("unregisters", async () => {
    const spy = vi.fn();
    const sink = new TaskCreatedSink();
    const off = sink.register({ name: "x", handle: spy });
    off();
    await sink.dispatch(event);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("degrades on a best-effort failure instead of failing the call", async () => {
    const sink = new TaskCreatedSink();
    const failure = new Error("registry unreachable");
    sink.register({
      name: "registry",
      bestEffort: true,
      handle: () => {
        throw failure;
      },
    });

    // The task is running on the server whether or not we recorded a recovery
    // row for it. Throwing here would tell the user their call failed.
    const result = await sink.dispatch(event);
    expect(result.degraded).toEqual([{ name: "registry", error: failure }]);
  });

  it("reports a best-effort failure rather than swallowing it", async () => {
    const sink = new TaskCreatedSink();
    sink.register({
      name: "registry",
      bestEffort: true,
      handle: async () => {
        throw new Error("timeout");
      },
    });
    const { degraded } = await sink.dispatch(event);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].name).toBe("registry");
  });

  it("propagates a functional-path failure — a lost handle is not degradation", async () => {
    const sink = new TaskCreatedSink();
    sink.register({
      name: "tracker",
      handle: () => {
        throw new Error("localStorage unavailable");
      },
    });
    await expect(sink.dispatch(event)).rejects.toThrow(
      "localStorage unavailable",
    );
  });

  it("keeps running the remaining consumers past a best-effort failure", async () => {
    const after = vi.fn();
    const sink = new TaskCreatedSink();
    sink.register({
      name: "registry",
      bestEffort: true,
      handle: () => {
        throw new Error("nope");
      },
    });
    sink.register({ name: "analytics", bestEffort: true, handle: after });

    await sink.dispatch(event);
    expect(after).toHaveBeenCalled();
  });

  it("keeps running the remaining consumers past a FUNCTIONAL failure", async () => {
    // The best-effort case above passed while this one did not: dispatch threw
    // from inside the loop, so a tracker write that failed took the stream part
    // and the registry record down with it, in registration order.
    const stream = vi.fn();
    const registry = vi.fn();
    const sink = new TaskCreatedSink();
    sink.register({
      name: "tracker",
      handle: () => {
        throw new Error("localStorage unavailable");
      },
    });
    sink.register({ name: "stream", handle: stream });
    sink.register({ name: "registry", bestEffort: true, handle: registry });

    await expect(sink.dispatch(event)).rejects.toThrow(
      "localStorage unavailable"
    );
    expect(stream).toHaveBeenCalled();
    expect(registry).toHaveBeenCalled();
  });

  it("reports every functional failure when more than one fails", async () => {
    const sink = new TaskCreatedSink();
    sink.register({
      name: "tracker",
      handle: () => {
        throw new Error("tracker down");
      },
    });
    sink.register({
      name: "stream",
      handle: () => {
        throw new Error("stream closed");
      },
    });
    sink.register({
      name: "registry",
      bestEffort: true,
      handle: () => {
        throw new Error("registry down");
      },
    });

    const failure = await sink.dispatch(event).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("tracker, stream");
    expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "tracker down",
      "stream closed",
    ]);
  });
});
