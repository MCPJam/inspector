import {
  evaluateToolCalls,
  findToolCallRetries,
  markFailedToolCalls,
  type EvalMatchOptions,
  type EvalToolCall,
} from "../src/matchers";
import { evaluateTurnExpectations } from "../src/tool-expectations";
import type { TurnExpectations } from "../src/tool-expectations";

const call = (
  toolName: string,
  args: Record<string, unknown> = {},
  failed?: boolean,
): EvalToolCall => ({
  toolName,
  arguments: args,
  ...(failed ? { failed: true } : {}),
});

const exportScene = (failed?: boolean) =>
  call("export_scene", { sceneId: "s1", format: "png" }, failed);
const share = () => call("share_scene", { sceneId: "s1" });

const strictOrder: EvalMatchOptions = { toolCallOrder: "strict" };
const noExtras: EvalMatchOptions = { maxExtraToolCalls: 0 };

describe("evaluateToolCalls — a failed call followed by the same call", () => {
  const expected = [exportScene(), share()];
  const retried = [exportScene(true), exportScene(), share()];

  it.each([
    ["strict order", strictOrder],
    ["zero extra calls", noExtras],
    ["both", { ...strictOrder, ...noExtras }],
  ])("passes under %s and reports the retry", (_, options) => {
    const result = evaluateToolCalls(expected, retried, options);
    expect(result.passed).toBe(true);
    expect(result.extra).toEqual([]);
    expect(result.retries).toEqual([
      {
        toolName: "export_scene",
        arguments: { sceneId: "s1", format: "png" },
        actualIndex: 0,
        retriedByIndex: 1,
      },
    ]);
  });

  it.each([
    ["strict order", strictOrder],
    ["zero extra calls", noExtras],
  ])("still fails two successful identical calls under %s", (_, options) => {
    const result = evaluateToolCalls(
      expected,
      [exportScene(), exportScene(), share()],
      options,
    );
    expect(result.passed).toBe(false);
    expect(result.retries).toEqual([]);
  });

  it("treats every failure before the success as a retry", () => {
    const result = evaluateToolCalls(
      expected,
      [exportScene(true), exportScene(true), exportScene(), share()],
      { ...strictOrder, ...noExtras },
    );
    expect(result.passed).toBe(true);
    expect(
      result.retries.map((r) => [r.actualIndex, r.retriedByIndex]),
    ).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("grades a failed call nobody retried as before", () => {
    const result = evaluateToolCalls(
      [share()],
      [exportScene(true), share()],
      noExtras,
    );
    expect(result.passed).toBe(false);
    expect(result.extra).toEqual([exportScene(true)]);
    expect(result.retries).toEqual([]);
  });

  it("does not treat a different call after a failure as its retry", () => {
    const result = evaluateToolCalls(
      expected,
      [
        exportScene(true),
        call("export_scene", { sceneId: "s1", format: "svg" }),
        share(),
      ],
      noExtras,
    );
    expect(result.retries).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it("matches the retry regardless of argument key order", () => {
    const result = evaluateToolCalls(
      expected,
      [
        exportScene(true),
        call("export_scene", { format: "png", sceneId: "s1" }),
        share(),
      ],
      { ...strictOrder, ...noExtras },
    );
    expect(result.passed).toBe(true);
    expect(result.retries).toHaveLength(1);
  });

  it("keeps the order a retry happened in: a share before the retry is out of order", () => {
    const result = evaluateToolCalls(
      expected,
      [exportScene(true), share(), exportScene()],
      strictOrder,
    );
    expect(result.passed).toBe(false);
    expect(result.retries).toHaveLength(1);
  });

  it("counts every call, retried ones included, against a negative test", () => {
    const result = evaluateToolCalls([], [exportScene(true), exportScene()], {
      isNegativeTest: true,
    });
    expect(result.passed).toBe(false);
    expect(result.extra).toHaveLength(2);
    expect(result.retries).toEqual([]);
  });
});

describe("findToolCallRetries", () => {
  it("ignores calls not marked failed", () => {
    expect(findToolCallRetries([exportScene(), exportScene()])).toEqual([]);
  });
});

describe("markFailedToolCalls", () => {
  const withId = (toolCallId: string) => ({ ...exportScene(), toolCallId });

  it("marks only the calls a failure names by id", () => {
    const calls = [withId("a"), withId("b")];
    const marked = markFailedToolCalls(calls, [
      { toolCallId: "a" },
      { toolCallId: undefined },
    ]);
    expect(marked[0]).toEqual({ ...withId("a"), failed: true });
    expect(marked[1]).toBe(calls[1]);
    expect(calls[0]).not.toHaveProperty("failed");
  });

  it("never marks a call without an id", () => {
    const calls = [exportScene()];
    expect(markFailedToolCalls(calls, [{ toolCallId: "a" }])[0]).toBe(
      calls[0],
    );
  });
});

describe("tool expectations read the same retry rule", () => {
  const turn = (
    order: TurnExpectations["order"],
    extrasCap: number | null,
  ): TurnExpectations => ({
    turnIndex: 0,
    order,
    extrasCap,
    negative: false,
    pinned: false,
    legacyExpected: [exportScene(), share()],
    legacyArgumentMatching: "partial",
    expectations: [
      {
        stepId: "export",
        position: 0,
        toolName: "export_scene",
        args: { sceneId: "s1", format: "png" },
        argumentMatching: "partial",
        minCount: 1,
      },
      {
        stepId: "share",
        position: 1,
        toolName: "share_scene",
        args: { sceneId: "s1" },
        argumentMatching: "partial",
        minCount: 1,
      },
    ],
  });

  it("passes a retried export under strict order with no extras", () => {
    const result = evaluateTurnExpectations(turn("strict", 0), [
      exportScene(true),
      exportScene(),
      share(),
    ]);
    expect(result.passed).toBe(true);
    expect(result.matcherEquivalent).toBe(true);
    expect(result.extras.count).toBe(0);
    expect(result.assertions[0]!.pairedCallIndexes).toEqual([1]);
  });

  it("still fails two successful exports", () => {
    const result = evaluateTurnExpectations(turn("strict", 0), [
      exportScene(),
      exportScene(),
      share(),
    ]);
    expect(result.passed).toBe(false);
    expect(result.matcherEquivalent).toBe(false);
  });
});
