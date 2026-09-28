/**
 * What a trial's facts say, and — more importantly — what they refuse to say.
 *
 * Every Tier 2 field is `undefined` rather than empty when the trace was not
 * read, because the engine reads `undefined` as "unreadable" and refuses to
 * build a claim from it. An empty array would read as "we looked and found
 * none", which is the false all-clear this whole layer exists to prevent.
 */

import { describe, expect, it } from "vitest";
import type { EvalIteration } from "@/components/evals/types";
import { trialFacts } from "../case-scorecard/trial-run-facts";

const iteration = (over: Partial<EvalIteration> = {}): EvalIteration =>
  ({
    _id: "it-1",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 500,
    startedAt: 100,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [{ toolName: "get_me", arguments: {} }],
    tokensUsed: 1200,
    suiteRunId: "run-1",
    ...over,
  }) as EvalIteration;

const blob = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: "assistant", content: "You are a@b.com" }],
  spans: [
    {
      category: "tool",
      toolCallId: "c1",
      promptIndex: 0,
      toolName: "get_me",
      startMs: 10,
      status: "ok",
    },
    // The runner's rollup span: same category, NO toolCallId.
    { category: "tool", name: "Tools (aggregate)", status: "ok" },
  ],
  ...over,
});

describe("read state", () => {
  it("keeps every Tier 2 field undefined when the trace was not read", () => {
    const f = trialFacts(iteration(), null, { state: "absent" });
    expect(f.readState).toBe("dto");
    expect(f.finalMessage).toBeUndefined();
    expect(f.toolErrors).toBeUndefined();
    expect(f.toolsByTurn).toBeUndefined();
    expect(f.renderedByTool).toBeUndefined();
    expect(f.clickCalls).toBeUndefined();
    // Tier 1 never needed it.
    expect(f.toolSequence).toEqual(["get_me"]);
    expect(f.tokensTotal).toBe(1200);
  });

  it("marks a failed read distinctly from an absent one", () => {
    expect(trialFacts(iteration(), null, { state: "failed" }).readState).toBe(
      "failed",
    );
  });

  it("reads Tier 2 when the blob arrived", () => {
    const f = trialFacts(iteration(), blob() as never, { state: "ok" });
    expect(f.readState).toBe("full");
    expect(f.finalMessage).toContain("a@b.com");
    expect(f.toolErrors).toEqual([]);
  });
});

describe("per-turn tools", () => {
  it("excludes the aggregate span, which has no toolCallId", () => {
    // Counting it would attribute a whole-run rollup to one turn.
    const f = trialFacts(iteration(), blob() as never, { state: "ok" });
    expect(f.toolsByTurn?.get(0)).toEqual(["get_me"]);
    expect(f.turnSource).toBe("spans");
  });

  it("falls back to blob.prompts when the runner emitted no spans", () => {
    const f = trialFacts(
      iteration(),
      blob({
        spans: [],
        prompts: [
          { promptIndex: 0, actualToolCalls: [{ toolName: "search" }] },
        ],
      }) as never,
      { state: "ok" },
    );
    expect(f.turnSource).toBe("prompts");
    expect(f.toolsByTurn?.get(0)).toEqual(["search"]);
  });

  it("ignores a malformed blob.prompts rather than half-trusting it", () => {
    const f = trialFacts(
      iteration(),
      blob({ spans: [], prompts: [{ promptIndex: "nope" }] }) as never,
      { state: "ok" },
    );
    expect(f.toolsByTurn).toBeUndefined();
  });

  it("uses the DTO sequence as turn 0 on a single-turn case", () => {
    const f = trialFacts(
      iteration(),
      blob({ spans: [] }) as never,
      { state: "ok" },
      { turnCountFromSteps: 1 },
    );
    expect(f.turnSource).toBe("dto-single-turn");
    expect(f.toolsByTurn?.get(0)).toEqual(["get_me"]);
  });

  it("gives up rather than guessing on a multi-turn case with no split", () => {
    const f = trialFacts(iteration(), blob({ spans: [] }) as never, {
      state: "ok",
    });
    expect(f.toolsByTurn).toBeUndefined();
  });
});

describe("tool errors", () => {
  it("attributes a span error to its turn", () => {
    const f = trialFacts(
      iteration(),
      blob({
        spans: [
          {
            category: "tool",
            toolCallId: "c1",
            promptIndex: 1,
            toolName: "get_me",
            status: "error",
          },
        ],
      }) as never,
      { state: "ok" },
    );
    expect(f.toolErrorsByTurn?.get(1)).toHaveLength(1);
  });

  it("counts a message-part error for the run but not for any turn", () => {
    // It carries no promptIndex, so a per-turn all-clear that ignored it
    // would be false.
    const f = trialFacts(
      iteration(),
      blob({
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "x",
                isError: true,
                output: "boom",
              },
            ],
          },
        ],
      }) as never,
      { state: "ok" },
    );
    expect((f.toolErrors ?? []).length).toBeGreaterThan(0);
    expect(f.toolErrorsByTurn?.size ?? 0).toBe(0);
  });
});

describe("success signal", () => {
  it("takes a passing judge verdict as the signal", () => {
    const f = trialFacts(
      iteration(),
      null,
      { state: "absent" },
      {
        judgeCase: { passed: true, status: "scored", score: 0.9 } as never,
      },
    );
    expect(f.successSignal).toBe("judge");
  });

  it("does not take an ERRORED judge verdict as a signal", () => {
    // A score the judge did not produce from evidence is a non-answer.
    const f = trialFacts(
      iteration(),
      null,
      { state: "absent" },
      {
        judgeCase: { passed: true, status: "error", score: 0 } as never,
      },
    );
    expect(f.successSignal).toBe("none");
  });

  it("accepts a passing gate when the case has one", () => {
    const f = trialFacts(
      iteration(),
      null,
      { state: "absent" },
      {
        authoredHasGate: true,
      },
    );
    expect(f.successSignal).toBe("gates");
  });

  it("reports no signal when the case has no gate and no judge", () => {
    expect(
      trialFacts(iteration(), null, { state: "absent" }).successSignal,
    ).toBe("none");
  });

  it("reports no signal for a trial that failed its gates", () => {
    const f = trialFacts(
      iteration({ result: "failed" }),
      null,
      { state: "absent" },
      { authoredHasGate: true },
    );
    expect(f.successSignal).toBe("none");
  });
});

describe("observed", () => {
  it.each(["completed", "failed"] as const)(
    "counts %s as observed",
    (status) => {
      expect(
        trialFacts(iteration({ status }), null, { state: "absent" }).observed,
      ).toBe(true);
    },
  );

  it.each(["cancelled", "timed_out", "running"] as const)(
    "does not count %s as observed",
    (status) => {
      expect(
        trialFacts(iteration({ status }), null, { state: "absent" }).observed,
      ).toBe(false);
    },
  );
});

describe("rendered views and clicks", () => {
  it("counts only a status of rendered", () => {
    const f = trialFacts(
      iteration(),
      blob({
        widgetRenderObservations: [
          { toolName: "cart", status: "rendered" },
          { toolName: "cart", status: "error" },
        ],
      }) as never,
      { state: "ok" },
    );
    expect(f.renderedByTool?.get("cart")).toEqual({ rendered: 1, total: 2 });
  });

  it("keeps the tools a click actually invoked", () => {
    const f = trialFacts(
      iteration(),
      blob({
        browserInteractionSteps: [
          {
            authoredStepId: "i1",
            promptIndex: 0,
            locatorLabel: "Add to cart",
            widgetToolCalls: [
              { name: "add_item", ok: true },
              { name: "broken", ok: false },
            ],
          },
        ],
      }) as never,
      { state: "ok" },
    );
    expect(f.clickCalls?.[0]).toMatchObject({
      authoredStepId: "i1",
      calledTools: ["add_item"],
      label: "Add to cart",
    });
  });
});

describe("Tier 1 derivations", () => {
  it("prefers structured usage over the flat token count", () => {
    const f = trialFacts(
      iteration({ usage: { totalTokens: 42 } as never }),
      null,
      { state: "absent" },
    );
    expect(f.tokensTotal).toBe(42);
  });

  it("reports no tokens rather than zero when nothing was measured", () => {
    expect(
      trialFacts(iteration({ tokensUsed: 0 }), null, { state: "absent" })
        .tokensTotal,
    ).toBeUndefined();
  });

  it("derives duration only from a sane start/end pair", () => {
    expect(trialFacts(iteration(), null, { state: "absent" }).durationMs).toBe(
      400,
    );
    expect(
      trialFacts(iteration({ startedAt: undefined }), null, { state: "absent" })
        .durationMs,
    ).toBeUndefined();
  });
});
