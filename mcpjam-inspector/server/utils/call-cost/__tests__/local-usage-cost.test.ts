import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCallCostEvidence } from "@mcpjam/sdk";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { PersistedTurnTrace } from "../../chat-ingestion.js";
import {
  localUsageCallsBody,
  readLocalUsageCosts,
  withLocalUsageCost,
  type TurnModelCall,
} from "../local-usage-cost.js";

const priced = (amountUsd: number): ModelCallCostEvidence => ({
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd,
  source: "list_price",
  funding: "customer",
});

const span = (
  id: string,
  category: EvalTraceSpan["category"],
  stepIndex?: number,
): EvalTraceSpan => ({
  id,
  name: id,
  category,
  startMs: 0,
  endMs: 1,
  ...(stepIndex === undefined ? {} : { stepIndex }),
});

const trace = (spans: EvalTraceSpan[]): PersistedTurnTrace => ({
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans,
  modelId: "gpt-4.1",
});

const call = (stepIndex: number, inputTokens: number): TurnModelCall => ({
  callId: `turn-1:${stepIndex}`,
  stepIndex,
  usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
  finishReason: stepIndex === 0 ? "tool-calls" : "stop",
  finishedAt: 100 + stepIndex,
});

describe("localUsageCallsBody", () => {
  it("sends a call without reported usage with an empty one", () => {
    const { usage: _usage, ...unreported } = call(0, 5);
    expect(localUsageCallsBody([unreported])[0]?.usage).toEqual({});
  });

  it("sends each call with its own id, usage and finish time", () => {
    expect(localUsageCallsBody([call(0, 5), call(1, 7)])).toEqual([
      {
        requestId: "turn-1:0",
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        finishReason: "tool-calls",
        finishedAt: 100,
      },
      {
        requestId: "turn-1:1",
        usage: { inputTokens: 7, outputTokens: 10, totalTokens: 17 },
        finishReason: "stop",
        finishedAt: 101,
      },
    ]);
  });
});

describe("readLocalUsageCosts", () => {
  it("reads each call's evidence and skips anything malformed", () => {
    expect(
      readLocalUsageCosts({
        ok: true,
        costs: {
          "turn-1:0": priced(0.1),
          "turn-1:1": { ...priced(0.2), amountUsd: undefined },
        },
      }),
    ).toEqual({ "turn-1:0": priced(0.1) });
    // A backend without per-call writeback answers with one `cost`.
    expect(readLocalUsageCosts({ ok: true, cost: priced(0.3) })).toEqual({});
    expect(readLocalUsageCosts("ok")).toEqual({});
  });
});

describe("withLocalUsageCost", () => {
  afterEach(() => vi.useRealTimers());

  it("puts each call's cost on the llm span of its step, in a turn of several calls", async () => {
    const turn = trace([
      span("step-0", "step", 0),
      span("llm-0", "llm", 0),
      span("tool", "tool", 0),
      span("llm-1", "llm", 1),
    ]);

    const result = await withLocalUsageCost(
      turn,
      [call(0, 50_000), call(1, 250_000)],
      Promise.resolve({
        "turn-1:0": priced(0.165),
        "turn-1:1": priced(1.5225),
      }),
    );

    expect(
      result.spans.map((s) => [s.id, s.callId, s.cost?.amountUsd]),
    ).toEqual([
      ["step-0", undefined, undefined],
      ["llm-0", "turn-1:0", 0.165],
      ["tool", undefined, undefined],
      ["llm-1", "turn-1:1", 1.5225],
    ]);
    expect(turn.spans[1]).not.toHaveProperty("cost");
    expect(turn.spans[1]).not.toHaveProperty("callId");
  });

  it("leaves a call the backend did not price without cost", async () => {
    const turn = trace([span("llm-0", "llm", 0), span("llm-1", "llm", 1)]);

    const result = await withLocalUsageCost(
      turn,
      [call(0, 5), call(1, 7)],
      Promise.resolve({ "turn-1:1": priced(0.2) }),
    );

    expect(result.spans.map((s) => s.cost?.amountUsd)).toEqual([
      undefined,
      0.2,
    ]);
  });

  it("keeps the trace as it was without calls", async () => {
    const turn = trace([span("llm", "llm", 0)]);
    expect(
      await withLocalUsageCost(turn, [], Promise.resolve({ x: priced(1) })),
    ).toBe(turn);
  });

  // The backend prices the usage row later and matches it to the span by id.
  it("puts the call id on the llm span when the writeback fails or never answers", async () => {
    const turn = trace([span("llm-0", "llm", 0), span("llm-9", "llm", 9)]);
    const unpriced = [
      { ...span("llm-0", "llm", 0), callId: "turn-1:0" },
      span("llm-9", "llm", 9),
    ];
    expect(
      (await withLocalUsageCost(turn, [call(0, 5)], Promise.resolve(undefined)))
        .spans,
    ).toEqual(unpriced);

    vi.useFakeTimers();
    const pending = withLocalUsageCost(
      turn,
      [call(0, 5)],
      new Promise(() => {}),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).spans).toEqual(unpriced);
  });
});
