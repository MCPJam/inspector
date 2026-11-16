import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCallCostEvidence } from "@mcpjam/sdk";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { PersistedTurnTrace } from "../../chat-ingestion.js";
import { readLocalUsageCost, withLocalUsageCost } from "../local-usage-cost.js";

const orgCost: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd: 0.0042,
  source: "customer_rate",
  funding: "customer",
};

const span = (
  id: string,
  category: EvalTraceSpan["category"],
): EvalTraceSpan => ({
  id,
  name: id,
  category,
  startMs: 0,
  endMs: 1,
});

const trace = (spans: EvalTraceSpan[]): PersistedTurnTrace => ({
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans,
  modelId: "gpt-4.1",
});

describe("readLocalUsageCost", () => {
  it("reads the backend's evidence and ignores anything malformed", () => {
    expect(readLocalUsageCost({ ok: true, cost: orgCost })).toEqual(orgCost);
    expect(readLocalUsageCost({ ok: true })).toBeUndefined();
    expect(
      readLocalUsageCost({
        ok: true,
        cost: { ...orgCost, amountUsd: undefined },
      }),
    ).toBeUndefined();
    expect(readLocalUsageCost("ok")).toBeUndefined();
  });
});

describe("withLocalUsageCost", () => {
  afterEach(() => vi.useRealTimers());

  it("puts a one-call turn's backend cost on its llm span only", async () => {
    const turn = trace([span("step", "step"), span("llm", "llm")]);

    const priced = await withLocalUsageCost(turn, Promise.resolve(orgCost));

    expect(priced.spans.map((s) => [s.category, s.cost])).toEqual([
      ["step", undefined],
      ["llm", orgCost],
    ]);
    expect(turn.spans[1]).not.toHaveProperty("cost");
  });

  it("leaves a turn of several calls without cost, since the backend priced their sum", async () => {
    const turn = trace([span("llm-0", "llm"), span("llm-1", "llm")]);

    expect(await withLocalUsageCost(turn, Promise.resolve(orgCost))).toBe(turn);
  });

  it("keeps the trace as it was when the writeback returns no cost or never answers", async () => {
    const turn = trace([span("llm", "llm")]);
    expect(await withLocalUsageCost(turn, Promise.resolve(undefined))).toBe(
      turn,
    );

    vi.useFakeTimers();
    const pending = withLocalUsageCost(turn, new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe(turn);
  });
});
