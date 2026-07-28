/**
 * `await` mode (`src/mcp-client-manager/task-await-driver.ts`).
 *
 * The point of these is that the drive **always terminates**, and that it does
 * so through a named outcome rather than by running out of evaluation budget.
 * The one the plan calls out specifically: a task needing human input nobody
 * can supply must return `input-required`, not hang.
 */

import { describe, expect, it, vi } from "vitest";
import {
  driveTaskToTerminal,
  type TaskAwaitResult,
} from "../src/mcp-client-manager/task-await-driver.js";
import {
  TaskLifecycleEngine,
  type TaskLifecycleIdentity,
  type TaskLifecycleObservation,
} from "../src/mcp-client-manager/task-lifecycle.js";
import type { ClientCapabilityOptions } from "../src/mcp-client-manager/types.js";

const identity: TaskLifecycleIdentity = {
  serverId: "srv",
  wire: "extension",
  taskId: "t1",
};

/** A clock the driver's injected `sleep` advances, so nothing waits for real. */
function controlledClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Answers `getTask` from a scripted sequence, repeating the last entry. */
function scriptedReads(sequence: TaskLifecycleObservation[]) {
  let index = 0;
  const calls: number[] = [];
  return {
    calls,
    getTask: async () => {
      calls.push(index);
      const value = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return value;
    },
  };
}

const working: TaskLifecycleObservation = {
  status: "working",
  pollIntervalMs: 1_000,
};

async function drive(
  overrides: Partial<Parameters<typeof driveTaskToTerminal>[0]> = {},
  clock = controlledClock(),
): Promise<TaskAwaitResult> {
  return driveTaskToTerminal({
    identity,
    getTask: async () => working,
    now: clock.now,
    sleep: clock.sleep,
    engine: new TaskLifecycleEngine({ now: clock.now }),
    ...overrides,
  });
}

describe("terminal outcomes", () => {
  it("returns completed with the inline result", async () => {
    const result = await drive({
      getTask: async () => ({
        status: "completed",
        result: { content: [{ type: "text", text: "done" }] },
      }),
    });
    expect(result.outcome).toBe("completed");
    expect(result.task?.result).toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("treats a tool result with isError as COMPLETED, not failed", async () => {
    // `failed` is only for JSON-RPC faults (tasks.md:837). Reporting a tool's
    // own error as a protocol failure would misattribute it.
    const result = await drive({
      getTask: async () => ({
        status: "completed",
        result: { content: [], isError: true },
      }),
    });
    expect(result.outcome).toBe("completed");
  });

  it("returns failed for a JSON-RPC fault", async () => {
    const result = await drive({
      getTask: async () => ({
        status: "failed",
        error: { code: -32000, message: "boom" },
      }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.task?.error).toEqual({ code: -32000, message: "boom" });
  });

  it("returns cancelled", async () => {
    const result = await drive({
      getTask: async () => ({ status: "cancelled" }),
    });
    expect(result.outcome).toBe("cancelled");
  });

  it("polls until the task finishes", async () => {
    const clock = controlledClock();
    const reads = scriptedReads([
      working,
      working,
      { status: "completed", result: {} },
    ]);
    const result = await drive({ getTask: reads.getTask }, clock);
    expect(result.outcome).toBe("completed");
    expect(reads.calls).toHaveLength(3);
  });
});

describe("bounded exits", () => {
  it("returns input-required rather than hanging when nothing can answer", async () => {
    const result = await drive({
      getTask: async () => ({
        status: "input_required",
        inputRequests: { k: { method: "elicitation/create" } } as never,
      }),
    });
    // The plan's TASK_INPUT_REQUIRED: deterministic, not a timeout.
    expect(result.outcome).toBe("input-required");
  });

  it("returns input-required naming the keys it could not answer", async () => {
    const result = await drive({
      getTask: async () => ({
        status: "input_required",
        inputRequests: { k: { method: "sampling/createMessage" } } as never,
      }),
      updateTask: async () => {},
      input: {
        // Sampling was never declared, so this key is unanswerable.
        declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
        handlers: { elicitation: async () => ({ action: "cancel" }) },
      },
    });
    expect(result.outcome).toBe("input-required");
    expect(result.unansweredInput?.[0]).toMatchObject({
      inputKey: "k",
      reason: "undeclared-capability",
    });
  });

  it("times out on a task that never finishes", async () => {
    const clock = controlledClock();
    const result = await drive(
      { getTask: async () => working, timeoutMs: 10_000 },
      clock,
    );
    expect(result.outcome).toBe("timeout");
  });

  it("reports timeout immediately when the next poll would overshoot the deadline", async () => {
    const clock = controlledClock();
    const reads = scriptedReads([{ status: "working", pollIntervalMs: 60_000 }]);
    const result = await drive(
      { getTask: reads.getTask, timeoutMs: 5_000 },
      clock,
    );
    expect(result.outcome).toBe("timeout");
    // One read, then the deadline check — never a 60s sleep past the budget.
    expect(reads.calls).toHaveLength(1);
  });

  it("retires the handle on a tasks/get -32602", async () => {
    const result = await drive({
      getTask: async () => {
        throw { code: -32602, message: "unknown task" };
      },
    });
    expect(result.outcome).toBe("expired");
    expect(result.task?.status).toBe("expired");
  });

  it("gives up after the consecutive-error budget, carrying the last error", async () => {
    const clock = controlledClock();
    const error = new Error("connect refused");
    const result = await drive(
      {
        getTask: async () => {
          throw error;
        },
        maxConsecutiveErrors: 3,
        timeoutMs: 10 * 60_000,
      },
      clock,
    );
    expect(result.outcome).toBe("unreachable");
    expect(result.lastError).toBe(error);
  });

  it("recovers when a transient read failure is followed by a good one", async () => {
    const clock = controlledClock();
    let call = 0;
    const result = await drive(
      {
        getTask: async () => {
          call += 1;
          if (call === 1) throw new Error("transient");
          return { status: "completed", result: {} };
        },
        timeoutMs: 60_000,
      },
      clock,
    );
    expect(result.outcome).toBe("completed");
  });

  it("stops on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await drive({ signal: controller.signal });
    expect(result.outcome).toBe("aborted");
  });
});

describe("input rounds", () => {
  it("answers, updates, and continues to a terminal state", async () => {
    const clock = controlledClock();
    const updates: Array<Record<string, unknown>> = [];
    let call = 0;
    const result = await drive(
      {
        getTask: async () => {
          call += 1;
          if (call === 1) {
            return {
              status: "input_required",
              inputRequests: {
                k: { method: "elicitation/create", params: {} },
              } as never,
            };
          }
          return { status: "completed", result: { ok: true } };
        },
        updateTask: async (_id, responses) => {
          updates.push(responses);
        },
        input: {
          declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
          handlers: {
            elicitation: async () => ({ action: "accept", content: {} }),
          },
        },
        timeoutMs: 60_000,
      },
      clock,
    );

    expect(result.outcome).toBe("completed");
    expect(updates).toEqual([{ k: { action: "accept", content: {} } }]);
  });

  it("does not re-answer a key once its update was acknowledged", async () => {
    const clock = controlledClock();
    const elicit = vi.fn(async () => ({ action: "accept", content: {} }));
    let call = 0;
    // The keyed snapshot is re-sent on every poll and `tasks/update` is
    // eventually consistent, so the SAME key comes back on the next read.
    await drive(
      {
        getTask: async () => {
          call += 1;
          if (call <= 2) {
            return {
              status: "input_required",
              inputRequests: {
                k: { method: "elicitation/create", params: {} },
              } as never,
            };
          }
          return { status: "completed", result: {} };
        },
        updateTask: async () => {},
        input: {
          declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
          handlers: { elicitation: elicit },
        },
        timeoutMs: 60_000,
      },
      clock,
    );
    expect(elicit).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark a key answered when the update fails", async () => {
    const clock = controlledClock();
    const elicit = vi.fn(async () => ({ action: "accept", content: {} }));
    let updateCalls = 0;
    let call = 0;
    await drive(
      {
        getTask: async () => {
          call += 1;
          if (call <= 2) {
            return {
              status: "input_required",
              inputRequests: {
                k: { method: "elicitation/create", params: {} },
              } as never,
            };
          }
          return { status: "completed", result: {} };
        },
        updateTask: async () => {
          updateCalls += 1;
          throw new Error("update rejected");
        },
        input: {
          declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
          handlers: { elicitation: elicit },
        },
        timeoutMs: 60_000,
      },
      clock,
    );
    // The answer was NOT silently discarded: it is re-collected and retried.
    expect(updateCalls).toBe(2);
    expect(elicit).toHaveBeenCalledTimes(2);
  });

  it("caps input rounds so a server that keeps asking cannot run forever", async () => {
    const clock = controlledClock();
    const result = await drive(
      {
        getTask: async () => ({
          status: "input_required",
          // A fresh key every round, so dedupe never converges.
          inputRequests: {
            [`k${Math.random()}`]: { method: "elicitation/create", params: {} },
          } as never,
        }),
        updateTask: async () => {},
        input: {
          declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
          handlers: {
            elicitation: async () => ({ action: "accept", content: {} }),
          },
        },
        maxInputRounds: 3,
        timeoutMs: 10 * 60_000,
      },
      clock,
    );
    expect(result.outcome).toBe("input-required");
  });
});

describe("poll discipline", () => {
  it("honors the advertised floor between reads — automation gets no licence", async () => {
    const clock = controlledClock();
    const slept: number[] = [];
    const reads = scriptedReads([
      { status: "working", pollIntervalMs: 30_000 },
      { status: "working", pollIntervalMs: 30_000 },
      { status: "completed", result: {} },
    ]);
    await driveTaskToTerminal({
      identity,
      getTask: reads.getTask,
      now: clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.advance(ms);
      },
      engine: new TaskLifecycleEngine({ now: clock.now }),
      timeoutMs: 10 * 60_000,
    });
    expect(slept.every((ms) => ms >= 30_000)).toBe(true);
  });

  it("follows a poll interval that changes mid-task", async () => {
    const clock = controlledClock();
    const slept: number[] = [];
    const reads = scriptedReads([
      { status: "working", pollIntervalMs: 20_000 },
      { status: "working", pollIntervalMs: 2_000 },
      { status: "completed", result: {} },
    ]);
    await driveTaskToTerminal({
      identity,
      getTask: reads.getTask,
      now: clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.advance(ms);
      },
      engine: new TaskLifecycleEngine({ now: clock.now }),
      timeoutMs: 10 * 60_000,
    });
    // A shrinking floor is normal and is followed, not flagged.
    expect(slept).toEqual([20_000, 2_000]);
  });
});
