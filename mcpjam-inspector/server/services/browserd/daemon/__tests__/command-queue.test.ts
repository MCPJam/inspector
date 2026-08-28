import { describe, expect, it } from "vitest";
import { CommandQueue, type CommandExecutor } from "../command-queue";
import type { BrowserCommand, BrowserCommandResult } from "../../protocol";

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A controllable fake executor. The queue invokes the executor one microtask
 * after `submit` (it chains onto the per-tab FIFO), so `release` waits until the
 * call for a given commandId has actually arrived before resolving it — no
 * hand-tuned tick counting in each test.
 */
function controllableExecutor() {
  const calls: BrowserCommand[] = [];
  const pending = new Map<
    string,
    { resolve: (r: BrowserCommandResult) => void; reject: (e: unknown) => void }
  >();
  const executor: CommandExecutor = (command) => {
    calls.push(command);
    return new Promise<BrowserCommandResult>((resolve, reject) => {
      pending.set(command.commandId, { resolve, reject });
    });
  };
  async function waitForCall(commandId: string) {
    for (let i = 0; i < 100 && !pending.has(commandId); i++) await tick();
    const p = pending.get(commandId);
    if (!p) throw new Error(`executor never called for ${commandId}`);
    return p;
  }
  async function release(commandId: string, result: BrowserCommandResult) {
    (await waitForCall(commandId)).resolve(result);
  }
  async function throwFor(commandId: string, error: unknown) {
    (await waitForCall(commandId)).reject(error);
  }
  return { executor, calls, release, throwFor };
}

function cmd(
  commandId: string,
  overrides: Partial<BrowserCommand> = {},
): BrowserCommand {
  return {
    commandId,
    source: "chat",
    action: { kind: "observe", mode: "url" },
    ...overrides,
  };
}

describe("browserd CommandQueue", () => {
  it("executes an unseen commandId once and returns its result (rule 1)", async () => {
    const { executor, calls, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a");
    const p = q.submit(cmd("c1"));
    await release("c1", { ok: true, output: "https://x.test" });
    expect(await p).toEqual({
      status: "ok",
      result: { ok: true, output: "https://x.test" },
      bootId: "boot-a",
    });
    expect(calls).toHaveLength(1);
  });

  it("attaches a duplicate WHILE running to the one execution (rule 2)", async () => {
    const { executor, calls, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a");
    const first = q.submit(cmd("c1"));
    await tick(); // let the executor be invoked for c1
    const dup = q.submit(cmd("c1")); // same id, still in flight
    expect(calls).toHaveLength(1); // NOT executed twice
    await release("c1", { ok: true, output: 42 });
    const [a, b] = await Promise.all([first, dup]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("returns the recorded result for a duplicate AFTER settle (rule 3)", async () => {
    const { executor, calls, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a");
    const first = q.submit(cmd("c1"));
    await release("c1", { ok: true, output: "done" });
    await first;
    const dup = await q.submit(cmd("c1"));
    expect(dup).toMatchObject({ status: "ok", result: { output: "done" } });
    expect(calls).toHaveLength(1); // never re-executed
  });

  it("serializes commands on the same tab (FIFO) but runs different tabs concurrently", async () => {
    const { executor, calls, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a");
    q.submit(cmd("t1a", { tabId: "tab-1" }));
    q.submit(cmd("t1b", { tabId: "tab-1" }));
    q.submit(cmd("t2a", { tabId: "tab-2" }));
    await tick();
    // tab-1's second command must NOT start until the first settles; tab-2 runs
    // immediately. So only t1a and t2a are in flight.
    expect(calls.map((c) => c.commandId).sort()).toEqual(["t1a", "t2a"]);
    await release("t1a", { ok: true });
    await tick();
    expect(calls.map((c) => c.commandId)).toContain("t1b"); // now t1b runs
  });

  it("rejects with `busy` at the per-queue depth cap (rule 1)", async () => {
    const { executor } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", { perQueueDepthCap: 2 });
    q.submit(cmd("a", { tabId: "tab-1" }));
    q.submit(cmd("b", { tabId: "tab-1" }));
    const third = await q.submit(cmd("c", { tabId: "tab-1" }));
    expect(third).toEqual({ status: "busy", bootId: "boot-a" });
  });

  it("evicts the oldest settled result by LRU and reports a later duplicate as `expired` (rule 4)", async () => {
    const { executor, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", { maxRetained: 1 });
    const first = q.submit(cmd("c1"));
    await release("c1", { ok: true, output: 1 });
    await first;
    const second = q.submit(cmd("c2"));
    await release("c2", { ok: true, output: 2 }); // settling c2 evicts c1 (cap 1)
    await second;
    expect(q.retainedCount).toBe(1);
    const dupOld = await q.submit(cmd("c1"));
    expect(dupOld).toEqual({ status: "expired", bootId: "boot-a" });
  });

  it("expires a settled result after its TTL and never re-executes it (rule 4, TTL arm)", async () => {
    const { executor, calls, release } = controllableExecutor();
    let clock = 1_000;
    const q = new CommandQueue(executor, "boot-a", {
      retainTtlMs: 100,
      now: () => clock,
    });
    const first = q.submit(cmd("c1"));
    await release("c1", { ok: true, output: "x" });
    await first;
    clock += 101; // age the result past its TTL
    const dup = await q.submit(cmd("c1"));
    expect(dup).toEqual({ status: "expired", bootId: "boot-a" });
    expect(calls).toHaveLength(1); // unknowable outcome — must NOT re-run
  });

  it("normalizes an executor that throws into a recorded {ok:false} result", async () => {
    const executor: CommandExecutor = async () => {
      throw new Error("cdp exploded");
    };
    const q = new CommandQueue(executor, "boot-a");
    const outcome = await q.submit(cmd("c1"));
    expect(outcome).toMatchObject({
      status: "ok",
      result: { ok: false, error: "cdp exploded" },
    });
    // A duplicate gets the same recorded failure, not a re-throw or re-run.
    const dup = await q.submit(cmd("c1"));
    expect(dup).toMatchObject({ result: { ok: false, error: "cdp exploded" } });
  });

  it("gives a duplicate the SAME normalized result when the executor throws (rule 2, P1 regression)", async () => {
    // The bug this guards: a duplicate attached while running used to await the
    // raw rejected promise and reject, while the original caller caught the same
    // failure and got a normalized {ok:false} outcome — two callers, two answers.
    const { executor, calls, throwFor } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a");
    const first = q.submit(cmd("c1"));
    await tick(); // executor invoked for c1
    const dup = q.submit(cmd("c1")); // attached while running
    await throwFor("c1", new Error("cdp exploded"));
    const [a, b] = await Promise.all([first, dup]); // neither rejects
    expect(a).toMatchObject({
      status: "ok",
      result: { ok: false, error: "cdp exploded" },
    });
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it("rejects nonsensical constructor limits instead of looping forever", () => {
    const { executor } = controllableExecutor();
    expect(() => new CommandQueue(executor, "b", { maxRetained: -1 })).toThrow(
      RangeError,
    );
    expect(() => new CommandQueue(executor, "b", { maxRetained: 1.5 })).toThrow(
      RangeError,
    );
    expect(
      () => new CommandQueue(executor, "b", { perQueueDepthCap: 0 }),
    ).toThrow(RangeError);
    expect(() => new CommandQueue(executor, "b", { retainTtlMs: -1 })).toThrow(
      RangeError,
    );
    expect(
      () => new CommandQueue(executor, "b", { retainTtlMs: Infinity }),
    ).toThrow(RangeError);
  });

  it("evicts least-recently-USED, not merely oldest-settled (rule 3 recency)", async () => {
    const { executor, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", { maxRetained: 2 });
    for (const id of ["c1", "c2"]) {
      const p = q.submit(cmd(id));
      await release(id, { ok: true, output: id });
      await p;
    }
    // Touch c1 so c2 is now the least-recently-used of the two.
    expect(await q.submit(cmd("c1"))).toMatchObject({ status: "ok" });
    const third = q.submit(cmd("c3"));
    await release("c3", { ok: true, output: "c3" });
    await third; // settling c3 must evict c2 (LRU), NOT c1 (FIFO would evict c1)
    expect(await q.submit(cmd("c1"))).toMatchObject({ status: "ok" });
    expect(await q.submit(cmd("c2"))).toEqual({
      status: "expired",
      bootId: "boot-a",
    });
  });

  it("bounds the tombstone set so a long-lived daemon cannot leak memory", async () => {
    const { executor, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", { maxRetained: 2 });
    for (let i = 0; i < 50; i++) {
      const id = `c${i}`;
      const p = q.submit(cmd(id));
      await release(id, { ok: true, output: i });
      await p;
    }
    expect(q.retainedCount).toBeLessThanOrEqual(2);
    expect(q.tombstoneCount).toBeLessThanOrEqual(2); // bounded by maxRetained
  });

  it("does not let one command's failure stall the rest of its tab's FIFO", async () => {
    const results: BrowserCommandResult[] = [
      { ok: false, error: "boom" },
      { ok: true, output: "recovered" },
    ];
    let i = 0;
    const executor: CommandExecutor = async () => results[i++];
    const q = new CommandQueue(executor, "boot-a");
    const a = await q.submit(cmd("a", { tabId: "tab-1" }));
    const b = await q.submit(cmd("b", { tabId: "tab-1" }));
    expect(a).toMatchObject({ result: { ok: false } });
    expect(b).toMatchObject({ result: { ok: true, output: "recovered" } });
  });
});
