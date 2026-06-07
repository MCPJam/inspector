import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import type {
  EvalTraceSpan,
  EvalTraceWidgetSnapshot,
  PromptTraceSummary,
} from "@/shared/eval-trace";
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "../persist-eval-trace.js";

type ActionCall = {
  ref: string;
  args: Record<string, unknown>;
};

function makeMockClient(opts: {
  appendResult?: { skipped: boolean };
  appendThrows?: Error;
} = {}): { client: ConvexHttpClient; calls: ActionCall[] } {
  const calls: ActionCall[] = [];
  const action = vi.fn(async (ref: string, args: Record<string, unknown>) => {
    calls.push({ ref, args });
    if (ref === "testSuites:appendEvalTurnTrace") {
      if (opts.appendThrows) throw opts.appendThrows;
      return opts.appendResult ?? { skipped: false };
    }
    if (ref === "testSuites:lockEvalSession") {
      // Default success response so tests that exercise the lock
      // helper's happy path don't accidentally take the swallowed-error
      // branch. Tests that need the failure path stub a thrower client
      // directly instead of going through this factory.
      return { skipped: false, locked: true, alreadyLocked: false };
    }
    throw new Error(`unexpected action ${ref}`);
  });
  return {
    client: { action } as unknown as ConvexHttpClient,
    calls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistEvalTraceFanout", () => {
  test("fans out N per-turn calls without setting terminal (deferred to lockEvalSessionAfterUpdate)", async () => {
    const { client, calls } = makeMockClient();

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

    expect(result).toEqual({ persisted: true, turnsWritten: 3 });

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

    // PR-2 review fix #2: the fanout no longer fires the terminal
    // lock. None of the per-turn calls carry a `terminal` arg;
    // callers fire `lockEvalSessionAfterUpdate` AFTER
    // updateTestIteration succeeds. Test name was "sets terminal
    // only on the last" pre-review; renamed to reflect actual
    // behavior.
    for (const call of appendCalls) {
      expect(call.args.terminal).toBeUndefined();
    }
  });

  test("buckets unindexed spans onto the last turn (lossless)", async () => {
    const { client, calls } = makeMockClient();

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
    const { client } = makeMockClient({ appendThrows: error });

    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
    });

    expect(result).toEqual({ persisted: false, turnsWritten: 0, error });
  });

  test("reports turnsWritten when fanout fails after N successful writes", async () => {
    // Mid-stream failure: turn 0 succeeds, turn 1 throws. Caller uses
    // turnsWritten > 0 to skip the W1 fallback (would orphan turn 0).
    const error = new Error("network blip on turn 1");
    let appendCount = 0;
    const action = vi.fn(async (ref: string) => {
      if (ref !== "testSuites:appendEvalTurnTrace") {
        throw new Error(`unexpected action ${ref}`);
      }
      appendCount += 1;
      if (appendCount === 2) throw error;
      return { skipped: false };
    });
    const client = { action } as unknown as ConvexHttpClient;

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
    const result = await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [
        { role: "user", content: "q0" } as ModelMessage,
        { role: "assistant", content: "a0" } as ModelMessage,
        { role: "user", content: "q1" } as ModelMessage,
        { role: "assistant", content: "a1" } as ModelMessage,
      ],
      spans,
      prompts: undefined,
    });

    expect(result).toEqual({ persisted: false, turnsWritten: 1, error });
  });

  test("falls back when the backend reports skipped:true", async () => {
    const { client } = makeMockClient({
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
    const { client, calls } = makeMockClient();

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

    expect(result).toEqual({ persisted: true, turnsWritten: 1 });
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
    const { client, calls } = makeMockClient();

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

  test("PR-2 fallback escape hatch: helper does not invoke the lock action itself", async () => {
    // Caller is responsible for firing lockEvalSessionAfterUpdate AFTER
    // updateTestIteration succeeds. The fanout helper must NEVER make
    // the lock call (the whole point of the split is to defer the lock
    // past the iteration-row write).
    const { client, calls } = makeMockClient();

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [
        { role: "user", content: "q" } as ModelMessage,
        { role: "assistant", content: "a" } as ModelMessage,
      ],
      spans: undefined,
      prompts: undefined,
    });

    const lockCalls = calls.filter(
      (c) => c.ref === "testSuites:lockEvalSession",
    );
    expect(lockCalls).toHaveLength(0);
  });

  test("falls back to Date.now() for startedAt when iterationStartedAt is absent", async () => {
    const { client, calls } = makeMockClient();
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

describe("lockEvalSessionAfterUpdate", () => {
  test("calls testSuites:lockEvalSession with the right iterationId + reason", async () => {
    const { client, calls } = makeMockClient();

    await lockEvalSessionAfterUpdate({
      convexClient: client,
      iterationId: "iter-7",
      reason: "eval_failed",
    });

    const lockCalls = calls.filter(
      (c) => c.ref === "testSuites:lockEvalSession",
    );
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0]!.args).toEqual({
      iterationId: "iter-7",
      reason: "eval_failed",
    });
  });

  test("swallows action errors so a missed lock doesn't fail a completed iteration", async () => {
    const action = vi.fn(async (ref: string) => {
      if (ref === "testSuites:lockEvalSession") {
        throw new Error("convex unreachable");
      }
      return undefined;
    });
    const client = { action } as unknown as ConvexHttpClient;

    // Must not throw — the iteration is already finalized at the call
    // site and the auto-lock inside internalUpdateTestIteration is the
    // backstop (PR-2 review #4 defense-in-depth).
    await expect(
      lockEvalSessionAfterUpdate({
        convexClient: client,
        iterationId: "iter-7",
        reason: "eval_completed",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("persistEvalTraceFanout — widget serialization", () => {
  const makeSnapshot = (
    overrides: Partial<EvalTraceWidgetSnapshot> = {},
  ): EvalTraceWidgetSnapshot => ({
    toolCallId: "call-1",
    toolName: "create_view",
    protocol: "mcp-apps",
    serverId: "excalidraw",
    toolMetadata: {},
    widgetHtmlBlobId: "storage-id-1",
    ...overrides,
  });

  test("widgets are attached to the LAST turn call only", async () => {
    const { client, calls } = makeMockClient();

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
      spans: undefined,
      prompts,
      widgetSnapshots: [makeSnapshot()],
    });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    expect(appendCalls).toHaveLength(2);
    const firstTurn = appendCalls[0]!.args.turn as { widgets: unknown[] };
    const lastTurn = appendCalls[1]!.args.turn as { widgets: unknown[] };
    expect(firstTurn.widgets).toEqual([]);
    expect(lastTurn.widgets).toHaveLength(1);
  });

  test("renames protocol → uiType and forwards friendly serverId verbatim", async () => {
    const { client, calls } = makeMockClient();

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "q" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
      widgetSnapshots: [
        makeSnapshot({ protocol: "openai-apps", serverId: "my-server" }),
      ],
    });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    const widget = (appendCalls[0]!.args.turn as { widgets: any[] }).widgets[0];
    expect(widget.uiType).toBe("openai-apps");
    expect(widget.serverId).toBe("my-server");
    // protocol is the inspector field name; backend never sees it.
    expect(widget.protocol).toBeUndefined();
  });

  test("drops widgets without widgetHtmlBlobId; other widgets pass through", async () => {
    const { client, calls } = makeMockClient();

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "q" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
      widgetSnapshots: [
        makeSnapshot({ toolCallId: "good", widgetHtmlBlobId: "blob-good" }),
        makeSnapshot({ toolCallId: "missing-blob", widgetHtmlBlobId: undefined }),
      ],
    });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    const widgets = (appendCalls[0]!.args.turn as { widgets: any[] }).widgets;
    expect(widgets).toHaveLength(1);
    expect(widgets[0].toolCallId).toBe("good");
  });

  test("sanitizes $-prefixed keys in widgetPermissions (Convex reserved-key protection)", async () => {
    const { client, calls } = makeMockClient();

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "q" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
      widgetSnapshots: [
        makeSnapshot({
          // JSON Schema-shaped permissions — `$ref` / `$schema` would
          // otherwise be rejected by Convex's argument validator and
          // collapse the entire `appendEvalTurnTrace` call.
          widgetPermissions: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {
              clipboard: {
                $ref: "#/definitions/Capability",
              },
            },
          },
        }),
      ],
    });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    const perms = ((appendCalls[0]!.args.turn as { widgets: any[] }).widgets[0])
      .widgetPermissions;
    expect(perms.$schema).toBeUndefined();
    expect(perms.__convexReserved__schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(perms.properties.clipboard.$ref).toBeUndefined();
    expect(perms.properties.clipboard.__convexReserved__ref).toBe(
      "#/definitions/Capability",
    );
  });

  test("normalizes widgetCsp to backend shape, drops unknown keys", async () => {
    const { client, calls } = makeMockClient();

    await persistEvalTraceFanout({
      convexClient: client,
      iterationId: "iter1",
      messages: [{ role: "user", content: "q" } as ModelMessage],
      spans: undefined,
      prompts: undefined,
      widgetSnapshots: [
        makeSnapshot({
          widgetCsp: {
            connectDomains: ["a.com", "b.com"],
            // Non-string entries filtered out.
            resourceDomains: ["good.com", 123 as unknown as string, null],
            unrelatedField: "ignored",
          },
        }),
      ],
    });

    const appendCalls = calls.filter(
      (c) => c.ref === "testSuites:appendEvalTurnTrace",
    );
    const csp = ((appendCalls[0]!.args.turn as { widgets: any[] }).widgets[0])
      .widgetCsp;
    expect(csp).toEqual({
      connectDomains: ["a.com", "b.com"],
      resourceDomains: ["good.com"],
    });
    expect(csp.unrelatedField).toBeUndefined();
  });
});
