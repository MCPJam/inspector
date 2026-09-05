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
  // Cleared on settle, so a SECOND call with the same id (only reachable for
  // untracked reads, which re-execute) waits for its own invocation rather
  // than resolving the previous one's already-settled promise.
  async function release(commandId: string, result: BrowserCommandResult) {
    const p = await waitForCall(commandId);
    pending.delete(commandId);
    p.resolve(result);
  }
  async function throwFor(commandId: string, error: unknown) {
    const p = await waitForCall(commandId);
    pending.delete(commandId);
    p.reject(error);
  }
  return { executor, calls, release, throwFor };
}

/**
 * A command with SIDE EFFECTS, which is what at-most-once exists to protect.
 *
 * Deliberately not an `observe`: reads are exempt from id tracking (they have
 * nothing to protect and would spend the per-boot budget for nothing), so
 * testing the de-duplication rules with one would assert the opposite of the
 * behaviour every rule below describes.
 */
function cmd(
  commandId: string,
  overrides: Partial<BrowserCommand> = {},
): BrowserCommand {
  return {
    commandId,
    source: "chat",
    action: { kind: "webmcp_invoke", toolKey: "origin::pay", input: {} },
    ...overrides,
  };
}

/** A read: same envelope, no side effects, not tracked by id. */
function readCmd(
  commandId: string,
  overrides: Partial<BrowserCommand> = {},
): BrowserCommand {
  return cmd(commandId, {
    action: { kind: "observe", mode: "url" },
    ...overrides,
  });
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
    expect(
      () =>
        new CommandQueue(executor, "b", {
          maxRetained: 10,
          maxCommandsPerBoot: 5, // must be >= maxRetained
        }),
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

  it("keeps a tombstone for the whole boot so an evicted id is never re-run (P1)", async () => {
    // The bug a count-bounded tombstone set would reintroduce: after enough
    // distinct commands the oldest tombstone is dropped, and a delayed retry of
    // that id re-runs a non-idempotent action. Tombstones must outlive the
    // result cache for the full boot.
    const { executor, calls, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", { maxRetained: 2 });
    for (let i = 0; i < 40; i++) {
      const id = `c${i}`;
      const p = q.submit(cmd(id));
      await release(id, { ok: true, output: i });
      await p;
    }
    const callsBefore = calls.length;
    // c0's RESULT was evicted long ago, but its tombstone remains.
    expect(await q.submit(cmd("c0"))).toEqual({
      status: "expired",
      bootId: "boot-a",
    });
    expect(calls.length).toBe(callsBefore); // NOT re-executed
    expect(q.tombstoneCount).toBeGreaterThan(2); // tombstones outlive the cache
  });

  it("refuses a NEW command at the per-boot ceiling rather than forgetting a tombstone", async () => {
    const { executor, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", {
      maxRetained: 2,
      maxCommandsPerBoot: 3,
    });
    for (const id of ["a", "b", "c"]) {
      const p = q.submit(cmd(id));
      await release(id, { ok: true });
      await p;
    }
    // 'a' was evicted from the 2-slot result cache but is tombstoned, so the
    // boot ledger now tracks 3 ids (b, c live + a tombstoned) = the ceiling.
    expect(await q.submit(cmd("d"))).toEqual({
      status: "at_capacity",
      bootId: "boot-a",
    });
    // A duplicate of an already-tracked id still resolves — capacity only gates
    // genuinely new commands.
    expect(await q.submit(cmd("a"))).toEqual({
      status: "expired",
      bootId: "boot-a",
    });
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

/**
 * Reads are exempt from at-most-once, and that exemption is what keeps the
 * daemon alive under a watching inspector.
 *
 * Every tracked id is remembered for the whole boot — as a result, then as a
 * tombstone — against `maxCommandsPerBoot`. The WebMCP inspector polls the
 * page's tool list for as long as somebody is watching, which is thousands of
 * observations an hour: enough to exhaust the budget in a day and leave the
 * daemon answering `at_capacity` to every command, including the ones whose
 * duplicates actually matter.
 */
describe("browserd CommandQueue — reads are not rationed", () => {
  it("re-executes a duplicate observe rather than replaying a stale answer", async () => {
    const { executor, calls, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a");

    const first = q.submit(readCmd("obs-1"));
    await release("obs-1", { ok: true, output: { url: "https://a.test" } });
    expect(await first).toMatchObject({ status: "ok" });

    // Same id, and it runs again — correct for a read, which should answer
    // with what the page looks like NOW rather than what it looked like then.
    const second = q.submit(readCmd("obs-1"));
    await release("obs-1", { ok: true, output: { url: "https://b.test" } });
    expect(await second).toMatchObject({
      status: "ok",
      result: { ok: true, output: { url: "https://b.test" } },
    });
    expect(calls).toHaveLength(2);
  });

  it("spends no part of the per-boot budget", async () => {
    const { executor, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", {
      maxRetained: 2,
      maxCommandsPerBoot: 2,
    });

    // Far more observations than the ceiling would ever allow.
    for (let i = 0; i < 10; i += 1) {
      const p = q.submit(readCmd(`obs-${i}`));
      await release(`obs-${i}`, { ok: true, output: {} });
      expect(await p).toMatchObject({ status: "ok" });
    }
    expect(q.retainedCount).toBe(0);
    expect(q.tombstoneCount).toBe(0);

    // ...and the budget is still entirely available to a command that needs it.
    const write = q.submit(cmd("pay-1"));
    await release("pay-1", { ok: true, output: {} });
    expect(await write).toMatchObject({ status: "ok" });
  });

  it("still queues reads behind the tab FIFO, and still caps their depth", async () => {
    // Exempt from ID TRACKING, not from ordering or admission control: a
    // viewer must not be able to stampede the browser with observations.
    const { executor, release } = controllableExecutor();
    const q = new CommandQueue(executor, "boot-a", { perQueueDepthCap: 1 });

    const first = q.submit(readCmd("obs-a", { tabId: "t1" }));
    await tick();
    const second = await q.submit(readCmd("obs-b", { tabId: "t1" }));
    expect(second).toMatchObject({ status: "busy" });

    await release("obs-a", { ok: true, output: {} });
    expect(await first).toMatchObject({ status: "ok" });
  });
});
