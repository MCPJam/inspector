import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import type { EvalTraceSpan, PromptTraceSummary } from "@/shared/eval-trace";
import {
  __resetEvalChatSessionsWriterFlagCacheForTests,
  isEvalChatSessionsWriterEnabled,
  persistEvalTraceFanout,
} from "../persist-eval-trace.js";

type ActionCall = {
  ref: string;
  args: Record<string, unknown>;
};

function makeMockClient(opts: {
  flagEnabled?: boolean;
  appendResult?: { skipped: boolean };
  appendThrows?: Error;
}): { client: ConvexHttpClient; calls: ActionCall[] } {
  const calls: ActionCall[] = [];
  const action = vi.fn(async (ref: string, args: Record<string, unknown>) => {
    calls.push({ ref, args });
    if (ref === "testSuites:isEvalChatSessionsWriterEnabled") {
      return { enabled: opts.flagEnabled ?? false };
    }
    if (ref === "testSuites:appendEvalTurnTrace") {
      if (opts.appendThrows) throw opts.appendThrows;
      return opts.appendResult ?? { skipped: false };
    }
    throw new Error(`unexpected action ${ref}`);
  });
  return {
    client: { action } as unknown as ConvexHttpClient,
    calls,
  };
}

beforeEach(() => {
  __resetEvalChatSessionsWriterFlagCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isEvalChatSessionsWriterEnabled", () => {
  test("caches the flag value across calls in the same process", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: true });

    const a = await isEvalChatSessionsWriterEnabled(client);
    const b = await isEvalChatSessionsWriterEnabled(client);
    const c = await isEvalChatSessionsWriterEnabled(client);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(c).toBe(true);
    // Only ONE network call across three reads.
    expect(
      calls.filter((c) => c.ref === "testSuites:isEvalChatSessionsWriterEnabled"),
    ).toHaveLength(1);
  });

  test("returns false (safe default) when the flag query throws", async () => {
    const client = {
      action: vi.fn(async () => {
        throw new Error("convex unreachable");
      }),
    } as unknown as ConvexHttpClient;

    const result = await isEvalChatSessionsWriterEnabled(client);
    expect(result).toBe(false);
  });
});

describe("persistEvalTraceFanout", () => {
  test("returns null and makes no per-turn calls when the flag is off", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: false });

    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
    });

    expect(result).toBeNull();
    expect(
      calls.filter((c) => c.ref === "testSuites:appendEvalTurnTrace"),
    ).toHaveLength(0);
  });

  test("fans out N per-turn calls and sets terminal only on the last", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: true });

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
      {
        id: "s2",
        name: "step",
        category: "step",
        startMs: 5,
        endMs: 6,
        promptIndex: 2,
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
      {
        promptIndex: 2,
        prompt: "p2",
        expectedToolCalls: [],
        actualToolCalls: [],
        passed: true,
        missing: [],
        unexpected: [],
        argumentMismatches: [],
      },
    ];
    const messages: ModelMessage[] = [
      { role: "user", content: "q0" } as ModelMessage,
      { role: "assistant", content: "a0" } as ModelMessage,
      { role: "user", content: "q1" } as ModelMessage,
      { role: "assistant", content: "a1" } as ModelMessage,
      { role: "user", content: "q2" } as ModelMessage,
      { role: "assistant", content: "a2" } as ModelMessage,
    ];

    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages,
      spans,
      prompts,
    });

    expect(result).toEqual({ persisted: true });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    expect(appendCalls).toHaveLength(3);

    // promptIndex sequence is 0, 1, 2.
    expect(
      appendCalls.map((c) => (c.args.turn as { promptIndex: number }).promptIndex),
    ).toEqual([0, 1, 2]);

    // Each turn carries its own spans (one each by promptIndex).
    for (let i = 0; i < appendCalls.length; i++) {
      const turn = appendCalls[i]!.args.turn as {
        spans: EvalTraceSpan[];
        sessionMessages: ModelMessage[];
      };
      expect(turn.spans).toHaveLength(1);
      expect(turn.spans[0]!.promptIndex).toBe(i);
      // Cumulative messages through end of turn i = (i+1) * 2 messages
      // (user + assistant pairs).
      expect(turn.sessionMessages).toHaveLength((i + 1) * 2);
    }

    // PR-2 review fix #2: the fanout no longer fires the terminal lock.
    // None of the per-turn calls carry a `terminal` arg; callers fire
    // `lockEvalSessionAfterUpdate` AFTER updateTestIteration succeeds.
    for (const call of appendCalls) {
      expect(call.args.terminal).toBeUndefined();
    }
  });

  test("buckets unindexed spans onto the last turn (lossless)", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: true });

    // Two prompts (indices 0, 1) + one span without promptIndex.
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
        id: "free",
        name: "step",
        category: "step",
        startMs: 3,
        endMs: 4,
      },
      {
        id: "s1",
        name: "step",
        category: "step",
        startMs: 5,
        endMs: 6,
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

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [
        { role: "user", content: "q0" } as ModelMessage,
        { role: "assistant", content: "a0" } as ModelMessage,
        { role: "user", content: "q1" } as ModelMessage,
        { role: "assistant", content: "a1" } as ModelMessage,
      ],
      spans,
      prompts,
    });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    const lastTurn = appendCalls[appendCalls.length - 1]!.args.turn as {
      spans: EvalTraceSpan[];
    };
    // Last turn carries its own indexed span PLUS the unindexed one.
    expect(lastTurn.spans.map((s) => s.id).sort()).toEqual(["free", "s1"]);
  });

  test("falls back when the action throws mid-fanout", async () => {
    const error = new Error("mid-fanout failure");
    const { client } = makeMockClient({ flagEnabled: true, appendThrows: error });

    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
    });

    expect(result).toEqual({ persisted: false, error });
  });

  test("falls back when the backend reports skipped:true (flag flipped mid-fanout)", async () => {
    const { client } = makeMockClient({
      flagEnabled: true,
      appendResult: { skipped: true },
    });

    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
    });

    expect(result).toEqual(
      expect.objectContaining({
        persisted: false,
      }),
    );
    expect((result as { error: Error }).error.message).toMatch(/skipped/);
  });

  test("traces with no spans/prompts persist as a single promptIndex:0 turn", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: true });

    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [
        { role: "user", content: "hi" } as ModelMessage,
        { role: "assistant", content: "hello" } as ModelMessage,
      ],
      spans: undefined,
      prompts: undefined,
    });

    expect(result).toEqual({ persisted: true });
    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    expect(appendCalls).toHaveLength(1);
    expect(
      (appendCalls[0]!.args.turn as { promptIndex: number }).promptIndex,
    ).toBe(0);
    // No terminal in fanout — caller fires lockEvalSessionAfterUpdate.
    expect(appendCalls[0]!.args.terminal).toBeUndefined();
  });

  test("threads iterationStartedAt through to the per-turn call (PR-2 review fix #1)", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: true });

    const realIterationStart = 1_700_000_000_000;
    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      iterationStartedAt: realIterationStart,
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
    });

    const appendCall = calls.find(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    expect(appendCall).toBeDefined();
    // The chatSessions row's startedAt is sourced from this arg, not
    // from Date.now() at finalize time.
    expect(appendCall!.args.startedAt).toBe(realIterationStart);
  });

  test("falls back to Date.now() for startedAt when iterationStartedAt is absent", async () => {
    const { client, calls } = makeMockClient({ flagEnabled: true });
    const before = Date.now();

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
    });

    const after = Date.now();
    const appendCall = calls.find(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    expect(appendCall!.args.startedAt).toBeGreaterThanOrEqual(before);
    expect(appendCall!.args.startedAt).toBeLessThanOrEqual(after);
  });
});
