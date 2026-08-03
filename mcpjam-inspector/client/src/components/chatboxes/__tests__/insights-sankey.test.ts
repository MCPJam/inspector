import { describe, expect, it } from "vitest";
import {
  DISCORDANT_OUTCOME_SENTIMENT,
  SANKEY_OTHER,
  SANKEY_UNLABELED,
  isDiscordantLink,
  parseNodeId,
  selectionForLink,
  selectionForNode,
  stageShare,
  stageValueLabel,
  toRechartsSankey,
} from "../insights-sankey";
import type {
  InsightsSankey,
  InsightsSankeyNode,
  SankeyStage,
} from "@/hooks/useUsageInsights";

function node(
  stage: SankeyStage,
  key: string,
  count: number,
  overrides: Partial<InsightsSankeyNode> = {},
): InsightsSankeyNode {
  return {
    id: `${stage}:${key}`,
    stage,
    key,
    label: key,
    count,
    clickable: true,
    ...overrides,
  };
}

describe("parseNodeId", () => {
  it("splits on the first colon so cluster ids survive", () => {
    expect(parseNodeId("goal:k57abc:def")).toEqual({
      stage: "goal",
      key: "k57abc:def",
    });
  });
});

describe("stageValueLabel", () => {
  it("names the unlabeled node honestly rather than as a verdict", () => {
    expect(stageValueLabel(node("outcome", SANKEY_UNLABELED, 3))).toBe(
      "Not analyzed",
    );
  });

  it("humanizes snake_case enum values", () => {
    expect(stageValueLabel(node("sentiment", "gave_up", 1))).toBe("Gave up");
    expect(stageValueLabel(node("behavior", "errored_tool", 1))).toBe(
      "Errored tool",
    );
  });

  it("leaves a goal label as the model wrote it", () => {
    expect(
      stageValueLabel(node("goal", "c1", 1, { label: "invoice lookup" })),
    ).toBe("invoice lookup");
  });
});

describe("isDiscordantLink", () => {
  it("flags a completed task the user was unhappy with", () => {
    expect(isDiscordantLink("outcome:completed", "sentiment:frustrated")).toBe(
      true,
    );
    expect(isDiscordantLink("outcome:completed", "sentiment:gave_up")).toBe(
      true,
    );
  });

  it("flags a failed task the user was happy with", () => {
    expect(isDiscordantLink("outcome:errored", "sentiment:satisfied")).toBe(
      true,
    );
    expect(isDiscordantLink("outcome:unresolved", "sentiment:satisfied")).toBe(
      true,
    );
  });

  it("leaves the agreeing diagonal alone", () => {
    expect(isDiscordantLink("outcome:completed", "sentiment:satisfied")).toBe(
      false,
    );
    expect(isDiscordantLink("outcome:errored", "sentiment:frustrated")).toBe(
      false,
    );
  });

  it("never calls neutral or unclear a disagreement", () => {
    // Absence of a reaction cannot disagree with anything; treating it as a
    // finding would paint most of the diagram as one.
    for (const outcome of Object.keys(DISCORDANT_OUTCOME_SENTIMENT)) {
      expect(isDiscordantLink(`outcome:${outcome}`, "sentiment:neutral")).toBe(
        false,
      );
      expect(isDiscordantLink(`outcome:${outcome}`, "sentiment:unclear")).toBe(
        false,
      );
    }
    expect(isDiscordantLink("outcome:unclear", "sentiment:frustrated")).toBe(
      false,
    );
  });

  it("exempts unlabeled endpoints on either side", () => {
    expect(
      isDiscordantLink(`outcome:${SANKEY_UNLABELED}`, "sentiment:frustrated"),
    ).toBe(false);
    expect(
      isDiscordantLink("outcome:completed", `sentiment:${SANKEY_UNLABELED}`),
    ).toBe(false);
  });

  it("is false for every stage pair that is not outcome → sentiment", () => {
    expect(isDiscordantLink("goal:c1", "behavior:looping")).toBe(false);
    expect(isDiscordantLink("behavior:looping", "outcome:errored")).toBe(false);
    // And not in reverse, either.
    expect(isDiscordantLink("sentiment:satisfied", "outcome:errored")).toBe(
      false,
    );
  });
});

describe("selectionForNode", () => {
  it("maps each stage to its own filter dimension", () => {
    expect(
      selectionForNode(node("goal", "c1", 4, { label: "Invoice lookup" })),
    ).toEqual({ goal: { clusterId: "c1", label: "Invoice lookup" } });
    expect(selectionForNode(node("behavior", "looping", 4))).toEqual({
      behavior: "looping",
    });
    expect(selectionForNode(node("outcome", "errored", 4))).toEqual({
      outcome: "errored",
    });
    expect(selectionForNode(node("sentiment", "gave_up", 4))).toEqual({
      sentiment: "gave_up",
    });
  });

  it("maps an unlabeled node to null, not to a missing key", () => {
    // `null` selects the sessions with no value; omitting the key would select
    // every session in the stage, which is a much wider filter than clicked.
    expect(selectionForNode(node("sentiment", SANKEY_UNLABELED, 4))).toEqual({
      sentiment: null,
    });
    expect(selectionForNode(node("outcome", SANKEY_UNLABELED, 4))).toEqual({
      outcome: null,
    });
  });

  it("refuses the nodes no chip can express", () => {
    expect(
      selectionForNode(node("goal", SANKEY_OTHER, 9, { clickable: false })),
    ).toBeNull();
    expect(
      selectionForNode(node("goal", SANKEY_UNLABELED, 9, { clickable: false })),
    ).toBeNull();
  });
});

describe("selectionForLink", () => {
  it("combines both endpoints", () => {
    expect(
      selectionForLink(
        node("outcome", "completed", 5),
        node("sentiment", "frustrated", 2),
      ),
    ).toEqual({ outcome: "completed", sentiment: "frustrated" });
  });

  it("refuses a link touching an unselectable endpoint", () => {
    // Half a link would silently widen to the other endpoint alone.
    expect(
      selectionForLink(
        node("goal", SANKEY_OTHER, 9, { clickable: false }),
        node("behavior", "looping", 4),
      ),
    ).toBeNull();
  });
});

describe("toRechartsSankey", () => {
  const sankey: InsightsSankey = {
    nodes: [
      node("goal", "c1", 3),
      node("behavior", "looping", 3),
      node("outcome", "errored", 3),
      node("sentiment", "frustrated", 3),
    ],
    links: [
      { source: "goal:c1", target: "behavior:looping", count: 3 },
      { source: "behavior:looping", target: "outcome:errored", count: 3 },
      { source: "outcome:errored", target: "sentiment:frustrated", count: 3 },
    ],
    foldedGoalCount: 0,
  };

  it("rewrites id-keyed links as index-keyed ones", () => {
    const data = toRechartsSankey(sankey);
    expect(data.links[0]).toMatchObject({ source: 0, target: 1, value: 3 });
    expect(data.links[2]).toMatchObject({ source: 2, target: 3, value: 3 });
  });

  it("orders nodes by stage so the columns read left to right", () => {
    const shuffled: InsightsSankey = {
      ...sankey,
      nodes: [...sankey.nodes].reverse(),
    };
    expect(toRechartsSankey(shuffled).nodes.map((n) => n.node.stage)).toEqual([
      "goal",
      "behavior",
      "outcome",
      "sentiment",
    ]);
  });

  it("keeps the source node on each entry", () => {
    expect(toRechartsSankey(sankey).nodes[0].node.id).toBe("goal:c1");
  });

  it("marks discordant links", () => {
    const discordant: InsightsSankey = {
      nodes: [node("outcome", "completed", 1), node("sentiment", "gave_up", 1)],
      links: [
        {
          source: "outcome:completed",
          target: "sentiment:gave_up",
          count: 1,
        },
      ],
      foldedGoalCount: 0,
    };
    expect(toRechartsSankey(discordant).links[0].discordant).toBe(true);
  });

  it("drops a link whose endpoint is missing rather than emitting index -1", () => {
    // recharts would render a -1 index as an edge from nowhere.
    const orphaned: InsightsSankey = {
      ...sankey,
      links: [
        ...sankey.links,
        { source: "goal:c1", target: "behavior:ghost", count: 1 },
      ],
    };
    const data = toRechartsSankey(orphaned);
    expect(data.links).toHaveLength(3);
    expect(data.links.every((link) => link.target >= 0)).toBe(true);
  });
});

describe("stageShare", () => {
  it("reports a node's share of its own stage", () => {
    const sankey: InsightsSankey = {
      nodes: [
        node("outcome", "completed", 3),
        node("outcome", "errored", 1),
        node("goal", "c1", 4),
      ],
      links: [],
      foldedGoalCount: 0,
    };
    expect(stageShare(sankey, sankey.nodes[0])).toBe(75);
    expect(stageShare(sankey, sankey.nodes[1])).toBe(25);
    // Denominator is the stage, not the whole diagram.
    expect(stageShare(sankey, sankey.nodes[2])).toBe(100);
  });

  it("returns 0 rather than dividing by zero for an empty stage", () => {
    expect(
      stageShare(
        { nodes: [], links: [], foldedGoalCount: 0 },
        node("outcome", "completed", 0),
      ),
    ).toBe(0);
  });
});
