import { describe, expect, it, vi } from "vitest";
import { createChatTurnQueue, createIdleGate } from "../chat-turn-queue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createChatTurnQueue", () => {
  it("starts a turn in the caller's tick when nothing is running", () => {
    const run = createChatTurnQueue();
    const task = vi.fn(async () => ({ result: true }));
    void run(task, createIdleGate());
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("starts the next turn only after the previous turn settles and the gate is idle", async () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    const first = deferred();
    void run(async () => ({ result: 1, turn: first.promise }), gate);
    gate.set({ idle: false, awaitingUser: false });
    const second = vi.fn(async () => ({ result: 2 }));
    const secondResult = run(second, gate);

    await flush();
    expect(second).not.toHaveBeenCalled();

    first.resolve();
    await flush();
    expect(second).not.toHaveBeenCalled();

    gate.set({ idle: true, awaitingUser: false });
    await expect(secondResult).resolves.toBe(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("runs queued turns one at a time, in call order", async () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    void run(async () => {
      started.push("reply");
      return { result: 0, turn: first.promise };
    }, gate);
    const a = run(async () => {
      started.push("a");
      return { result: 1, turn: second.promise };
    }, gate);
    const b = run(async () => {
      started.push("b");
      return { result: 2 };
    }, gate);

    first.resolve();
    await expect(a).resolves.toBe(1);
    await flush();
    expect(started).toEqual(["reply", "a"]);

    second.resolve();
    await expect(b).resolves.toBe(2);
    expect(started).toEqual(["reply", "a", "b"]);
  });

  it("releases the next turn when a turn's request rejects", async () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    const first = deferred();
    void run(async () => ({ result: 1, turn: first.promise }), gate);
    const second = vi.fn(async () => ({ result: 2 }));
    const secondResult = run(second, gate);

    first.reject(new Error("stream failed"));
    await expect(secondResult).resolves.toBe(2);
  });

  it("releases the next turn when a task throws or starts no request", async () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    const failed = run(async () => {
      throw new Error("preflight failed");
    }, gate);
    const refused = run(async () => ({ result: false }), gate);
    const next = run(async () => ({ result: "sent" }), gate);

    await expect(failed).rejects.toThrow("preflight failed");
    await expect(refused).resolves.toBe(false);
    await expect(next).resolves.toBe("sent");
  });

  it("starts a send at once when nothing is queued, even with an approval pending", () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    gate.set({ idle: true, awaitingUser: true });
    const task = vi.fn(async () => ({ result: true }));
    void run(task, gate);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("holds a queued send while the ended turn waits on the user", async () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    const first = deferred();
    void run(async () => ({ result: 1, turn: first.promise }), gate);
    gate.set({ idle: false, awaitingUser: false });
    const second = vi.fn(async () => ({ result: 2 }));
    const secondResult = run(second, gate);

    first.resolve();
    gate.set({ idle: true, awaitingUser: true });
    await flush();
    expect(second).not.toHaveBeenCalled();

    gate.set({ idle: true, awaitingUser: false });
    await expect(secondResult).resolves.toBe(2);
  });

  it("waits for the previous turn's request even when the status already reads idle", async () => {
    const run = createChatTurnQueue();
    const gate = createIdleGate();
    const first = deferred();
    void run(async () => ({ result: 1, turn: first.promise }), gate);
    const second = vi.fn(async () => ({ result: 2 }));
    const secondResult = run(second, gate);

    await flush();
    expect(second).not.toHaveBeenCalled();

    first.resolve();
    await expect(secondResult).resolves.toBe(2);
  });
});
