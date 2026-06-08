import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import type {
  EvalTraceSpan,
  PromptTraceSummary,
} from "@/shared/eval-trace";
import { finalizeEvalIteration } from "../finalize-iteration.js";

type Call = { ref: string; args: Record<string, unknown> };

function makeClient(opts: {
  /** When set, the first call to `testSuites:updateTestIteration` throws. */
  updateThrows?: Error;
  /** When set, ALL calls to `testSuites:appendEvalTurnTrace` throw (fanout
   *  fails before any turn lands → triggers the W1 fallback). */
  appendThrows?: Error;
  /** When set, returns this `status` from `testSuites:getTestIteration`. */
  iterationStatus?: string;
}): {
  client: ConvexHttpClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query = vi.fn(async (ref: string, args: Record<string, unknown>) => {
    calls.push({ ref, args });
    if (ref === "testSuites:getTestIteration") {
      if (opts.iterationStatus) {
        return { status: opts.iterationStatus };
      }
      return { status: "running" };
    }
    throw new Error(`unexpected query ${ref}`);
  });
  const action = vi.fn(async (ref: string, args: Record<string, unknown>) => {
    calls.push({ ref, args });
    if (ref === "testSuites:appendEvalTurnTrace") {
      if (opts.appendThrows) throw opts.appendThrows;
      return { skipped: false };
    }
    if (ref === "testSuites:updateTestIteration") {
      if (opts.updateThrows) throw opts.updateThrows;
      return undefined;
    }
    if (ref === "testSuites:lockEvalSession") {
      return { skipped: false, locked: true, alreadyLocked: false };
    }
    throw new Error(`unexpected action ${ref}`);
  });
  return {
    client: { query, action } as unknown as ConvexHttpClient,
    calls,
  };
}

const messages: ModelMessage[] = [
  { role: "user", content: "q0" } as ModelMessage,
  { role: "assistant", content: "a0" } as ModelMessage,
];
const usageZero = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalizeEvalIteration", () => {
  test("early-returns when iterationId is absent", async () => {
    const { client, calls } = makeClient({});
    await finalizeEvalIteration({
      convexClient: client,
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
    });
    expect(calls).toHaveLength(0);
  });

  test("skips update when the iteration is already cancelled", async () => {
    const { client, calls } = makeClient({ iterationStatus: "cancelled" });
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
    });
    // Only the pre-check `getTestIteration` query should have happened.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe("testSuites:getTestIteration");
  });

  test("W1 fallback includes systemPrompt when set (regression: systemPrompt-slot)", async () => {
    // Fanout fails before any turn lands → W1 fallback path. systemPrompt
    // must round-trip into `updateTestIteration` so the resolved system
    // prompt isn't dropped. This is the load-bearing bug class this PR
    // prevents (the Cursor follow-ups had to fix it in BOTH paths).
    const { client, calls } = makeClient({
      appendThrows: new Error("fanout pre-turn failure"),
    });
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
      systemPrompt: "You are a careful assistant.",
    });
    const update = calls.find(
      (c) => c.ref === "testSuites:updateTestIteration",
    );
    expect(update).toBeDefined();
    expect(update!.args.systemPrompt).toBe("You are a careful assistant.");
    // Messages forwarded too (W1 single-call save).
    expect(update!.args.messages).toBeDefined();
  });

  test("W1 fallback omits systemPrompt when unset", async () => {
    const { client, calls } = makeClient({
      appendThrows: new Error("fanout pre-turn failure"),
    });
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
    });
    const update = calls.find(
      (c) => c.ref === "testSuites:updateTestIteration",
    );
    expect(update).toBeDefined();
    expect("systemPrompt" in update!.args).toBe(false);
  });

  test("W1 fallback omits empty spans/prompts/widgetSnapshots", async () => {
    const { client, calls } = makeClient({
      appendThrows: new Error("fanout pre-turn failure"),
    });
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
      spans: [],
      prompts: [],
      widgetSnapshots: [],
    });
    const update = calls.find(
      (c) => c.ref === "testSuites:updateTestIteration",
    );
    expect(update).toBeDefined();
    expect("spans" in update!.args).toBe(false);
    expect("prompts" in update!.args).toBe(false);
    expect("widgetSnapshots" in update!.args).toBe(false);
  });

  test("terminalReason: completed + passed:false → eval_completed (verdict-only failure is not a cycle failure)", async () => {
    const { client, calls } = makeClient({});
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: false,
      toolsCalled: [],
      usage: usageZero,
      messages,
      status: "completed",
    });
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeDefined();
    expect(lock!.args.reason).toBe("eval_completed");
  });

  test("terminalReason: completed + error set → eval_failed (cycle failure)", async () => {
    const { client, calls } = makeClient({});
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: false,
      toolsCalled: [],
      usage: usageZero,
      messages,
      status: "completed",
      error: "provider rejected request",
    });
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeDefined();
    expect(lock!.args.reason).toBe("eval_failed");
  });

  test("terminalReason: cancelled → eval_cancelled", async () => {
    const { client, calls } = makeClient({});
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: false,
      toolsCalled: [],
      usage: usageZero,
      messages,
      status: "cancelled",
    });
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeDefined();
    expect(lock!.args.reason).toBe("eval_cancelled");
  });

  test("fanout-mid-stream-fail (persisted:false, turnsWritten>0) → no W1 spread, no re-attempt", async () => {
    // Turn 0 succeeds, turn 1 throws. `turnsWritten > 0` so we must NOT
    // re-send trace fields to `updateTestIteration` — would overwrite
    // turn 0 and orphan later turns.
    let appendCount = 0;
    const calls: Call[] = [];
    const query = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      calls.push({ ref, args });
      return { status: "running" };
    });
    const action = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      calls.push({ ref, args });
      if (ref === "testSuites:appendEvalTurnTrace") {
        appendCount += 1;
        if (appendCount === 2) throw new Error("network blip on turn 1");
        return { skipped: false };
      }
      if (ref === "testSuites:updateTestIteration") return undefined;
      if (ref === "testSuites:lockEvalSession") {
        return { skipped: false, locked: true, alreadyLocked: false };
      }
      throw new Error(`unexpected ${ref}`);
    });
    const client = { query, action } as unknown as ConvexHttpClient;

    const spans: EvalTraceSpan[] = [
      {
        id: "s0",
        name: "step",
        category: "step",
        startMs: 1,
        endMs: 2,
        promptIndex: 0,
      },
      {
        id: "s1",
        name: "step",
        category: "step",
        startMs: 3,
        endMs: 4,
        promptIndex: 1,
      },
    ];
    const prompts: PromptTraceSummary[] = [
      {
        promptIndex: 0,
        prompt: "p0",
        expectedToolCalls: [],
        actualToolCalls: [],
        passed: true,
        missing: [],
        unexpected: [],
        argumentMismatches: [],
      },
      {
        promptIndex: 1,
        prompt: "p1",
        expectedToolCalls: [],
        actualToolCalls: [],
        passed: true,
        missing: [],
        unexpected: [],
        argumentMismatches: [],
      },
    ];

    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages: [
        { role: "user", content: "q0" } as ModelMessage,
        { role: "assistant", content: "a0" } as ModelMessage,
        { role: "user", content: "q1" } as ModelMessage,
        { role: "assistant", content: "a1" } as ModelMessage,
      ],
      spans,
      prompts,
      systemPrompt: "sys",
    });

    const update = calls.find(
      (c) => c.ref === "testSuites:updateTestIteration",
    );
    expect(update).toBeDefined();
    // No W1 spread because turnsWritten > 0.
    expect("messages" in update!.args).toBe(false);
    expect("systemPrompt" in update!.args).toBe(false);
    expect("spans" in update!.args).toBe(false);
    expect("prompts" in update!.args).toBe(false);
    // Lock skipped because fanout.persisted === false.
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeUndefined();
  });

  test("onRunDeleted invoked when updateTestIteration throws 'not found'", async () => {
    const { client } = makeClient({
      updateThrows: new Error("iteration not found"),
    });
    const onRunDeleted = vi.fn();
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
      onRunDeleted,
    });
    expect(onRunDeleted).toHaveBeenCalledTimes(1);
  });

  test("onRunDeleted invoked when updateTestIteration throws 'unauthorized'", async () => {
    const { client } = makeClient({
      updateThrows: new Error("unauthorized"),
    });
    const onRunDeleted = vi.fn();
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
      onRunDeleted,
    });
    expect(onRunDeleted).toHaveBeenCalledTimes(1);
  });

  test("onRunDeleted invoked when updateTestIteration throws 'cancelled'", async () => {
    const { client } = makeClient({
      updateThrows: new Error("iteration cancelled"),
    });
    const onRunDeleted = vi.fn();
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
      onRunDeleted,
    });
    expect(onRunDeleted).toHaveBeenCalledTimes(1);
  });

  test("onRunDeleted NOT invoked on transient update failures", async () => {
    const { client } = makeClient({
      updateThrows: new Error("connection reset"),
    });
    const onRunDeleted = vi.fn();
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
      onRunDeleted,
    });
    expect(onRunDeleted).not.toHaveBeenCalled();
  });

  test("lock fires when fanout persisted + update succeeds", async () => {
    const { client, calls } = makeClient({});
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
    });
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeDefined();
    expect(lock!.args).toMatchObject({
      iterationId: "iter1",
      reason: "eval_completed",
    });
  });

  test("lock SKIPS when iteration is gone (onRunDeleted branch)", async () => {
    const { client, calls } = makeClient({
      updateThrows: new Error("iteration not found"),
    });
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
    });
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeUndefined();
  });

  test("lock STILL fires on transient update failure when fanout persisted", async () => {
    // PR-2 review #5: transient (non-cancellation) update failures must
    // still trigger the lock so retries don't accumulate partial writes
    // against a row whose chatSessions transcript is already complete.
    const { client, calls } = makeClient({
      updateThrows: new Error("connection reset"),
    });
    await finalizeEvalIteration({
      convexClient: client,
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: usageZero,
      messages,
    });
    const lock = calls.find((c) => c.ref === "testSuites:lockEvalSession");
    expect(lock).toBeDefined();
  });
});
