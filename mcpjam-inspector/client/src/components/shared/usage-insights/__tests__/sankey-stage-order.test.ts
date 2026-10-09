import { describe, expect, it } from "vitest";

import {
  applyStageOrder,
  applyStageVisibility,
  mergeVisibleOrder,
  parseStageLayout,
  stageOrderStorageKey,
} from "../sankey-stage-order";

describe("applyStageOrder", () => {
  const stages = ["goal", "behavior", "outcome", "sentiment"] as const;

  it("keeps catalog order when nothing was saved", () => {
    expect(applyStageOrder(stages, null)).toEqual([...stages]);
    expect(applyStageOrder(stages, [])).toEqual([...stages]);
  });

  it("replays a saved permutation", () => {
    expect(
      applyStageOrder(stages, ["sentiment", "goal", "behavior", "outcome"]),
    ).toEqual(["sentiment", "goal", "behavior", "outcome"]);
  });

  it("drops removed columns and appends new ones", () => {
    expect(
      applyStageOrder(
        ["goal", "behavior", "question:new"],
        ["question:gone", "behavior", "goal"],
      ),
    ).toEqual(["behavior", "goal", "question:new"]);
  });
});

describe("applyStageVisibility", () => {
  const stages = ["goal", "behavior", "outcome", "sentiment"] as const;

  it("drops hidden catalog columns", () => {
    expect(applyStageVisibility(stages, ["sentiment", "behavior"])).toEqual([
      "goal",
      "outcome",
    ]);
  });

  it("keeps one column if every id is hidden", () => {
    expect(applyStageVisibility(stages, [...stages])).toEqual(["goal"]);
  });
});

describe("mergeVisibleOrder", () => {
  it("keeps hidden columns in their slots while visible ones move", () => {
    expect(
      mergeVisibleOrder(
        ["goal", "behavior", "outcome", "sentiment"],
        ["outcome", "goal", "behavior"],
        ["sentiment"],
      ),
    ).toEqual(["outcome", "goal", "behavior", "sentiment"]);
  });
});

describe("parseStageLayout", () => {
  it("reads a legacy order array as no hidden columns", () => {
    expect(parseStageLayout(["sentiment", "goal"])).toEqual({
      order: ["sentiment", "goal"],
      hidden: [],
    });
  });

  it("reads the order-plus-hidden blob", () => {
    expect(
      parseStageLayout({
        order: ["goal", "sentiment"],
        hidden: ["sentiment"],
      }),
    ).toEqual({
      order: ["goal", "sentiment"],
      hidden: ["sentiment"],
    });
  });
});

describe("stageOrderStorageKey", () => {
  it("scopes each surface so swarms do not share a bench order", () => {
    expect(
      stageOrderStorageKey({ kind: "swarm", projectId: "proj" }),
    ).toBe("swarm:proj");
    expect(
      stageOrderStorageKey({ kind: "scenario", scenarioId: "sc" }),
    ).toBe("scenario:sc");
    expect(
      stageOrderStorageKey({ kind: "benchmark", benchmarkRunId: "run" }),
    ).toBe("benchmark:run");
  });
});
