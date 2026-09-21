import { describe, expect, it } from "vitest";
import {
  SANKEY_OTHER,
  SANKEY_UNLABELED,
  STAGE_ORDER,
  isDiscordantLink,
  layoutSankey,
  parseNodeId,
  selectionForLink,
  selectionForNode,
  stageTotal,
  stageValueLabel,
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
    label: `Theme ${key}`,
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
  it("passes a theme name through untouched", () => {
    // The label is emergent — already written for people — so nothing here
    // should be reformatting it.
    expect(
      stageValueLabel(
        node("behavior", "b1", 3, {
          label: "Guessed an id after truncation",
        }),
      ),
    ).toBe("Guessed an id after truncation");
  });

  it("names the unlabeled node honestly rather than as a theme", () => {
    expect(stageValueLabel(node("outcome", SANKEY_UNLABELED, 3))).toBe(
      "Not analyzed",
    );
  });
});

describe("isDiscordantLink", () => {
  it("trusts the server's count rather than reading the labels", () => {
    // Themes are emergent, so nothing here could tell whether "Goal reached"
    // and "Frustrated" disagree. The enums answered that server-side.
    expect(isDiscordantLink({ count: 10, discordantCount: 8 })).toBe(true);
    expect(isDiscordantLink({ count: 10, discordantCount: 2 })).toBe(false);
  });

  it("needs at least half, so one odd session does not paint a band", () => {
    // The threshold is `>=`, so an exact half counts. Spelled out because
    // "majority" would describe a different boundary than the one implemented.
    expect(isDiscordantLink({ count: 40, discordantCount: 1 })).toBe(false);
    expect(isDiscordantLink({ count: 40, discordantCount: 19 })).toBe(false);
    expect(isDiscordantLink({ count: 40, discordantCount: 20 })).toBe(true);
  });

  it("is false when the server sent no count at all", () => {
    expect(isDiscordantLink({ count: 5 })).toBe(false);
    expect(isDiscordantLink({ count: 0, discordantCount: 0 })).toBe(false);
  });
});

describe("selectionForNode", () => {
  it("maps a theme to a chip carrying its own axis", () => {
    expect(
      selectionForNode(node("behavior", "b1", 4, { label: "Repeated calls" })),
    ).toEqual({
      themes: [
        { dimension: "behavior", clusterId: "b1", label: "Repeated calls" },
      ],
    });
  });

  it("refuses the nodes no chip can express", () => {
    // `__other__` is a union of themes and `__unlabeled__` is the absence of
    // one; a cluster chip says neither.
    expect(
      selectionForNode(node("goal", SANKEY_OTHER, 9, { clickable: false })),
    ).toBeNull();
    expect(
      selectionForNode(
        node("sentiment", SANKEY_UNLABELED, 9, { clickable: false }),
      ),
    ).toBeNull();
  });
});

describe("selectionForLink", () => {
  it("combines both endpoints", () => {
    expect(
      selectionForLink(
        node("outcome", "o1", 5, { label: "Goal reached" }),
        node("sentiment", "s1", 2, { label: "Frustrated" }),
      ),
    ).toEqual({
      themes: [
        { dimension: "outcome", clusterId: "o1", label: "Goal reached" },
        { dimension: "sentiment", clusterId: "s1", label: "Frustrated" },
      ],
    });
  });

  it("refuses a link touching an unselectable endpoint", () => {
    // Half a link would silently widen to the other endpoint alone.
    expect(
      selectionForLink(
        node("goal", SANKEY_OTHER, 9, { clickable: false }),
        node("behavior", "b1", 4),
      ),
    ).toBeNull();
  });
});

describe("layoutSankey", () => {
  const sankey: InsightsSankey = {
    nodes: [
      node("goal", "g1", 6),
      node("goal", "g2", 4),
      node("behavior", "b1", 10),
      node("outcome", "o1", 10),
      node("sentiment", "s1", 10),
    ],
    links: [
      { source: "goal:g1", target: "behavior:b1", count: 6 },
      { source: "goal:g2", target: "behavior:b1", count: 4 },
      { source: "behavior:b1", target: "outcome:o1", count: 10 },
      { source: "outcome:o1", target: "sentiment:s1", count: 10 },
    ],
    foldedGoalCount: 0,
    foldedByStage: {},
  };
  const columnX = [0, 100, 200, 300];

  it("keeps each stage in the order the server sent", () => {
    // Volume order is the one ordering that means the same thing across
    // scenarios, so the layout must not re-sort.
    const laid = layoutSankey(sankey, 400, 200, columnX, STAGE_ORDER);
    expect(
      laid.nodes.filter((n) => n.stage === "goal").map((n) => n.key),
    ).toEqual(["g1", "g2"]);
  });

  it("sizes nodes in proportion and reports each one's share of its stage", () => {
    const laid = layoutSankey(sankey, 400, 200, columnX, STAGE_ORDER);
    const g1 = laid.nodes.find((n) => n.key === "g1")!;
    const g2 = laid.nodes.find((n) => n.key === "g2")!;
    expect(g1.height).toBeGreaterThan(g2.height);
    expect(g1.share).toBe(60);
    expect(g2.share).toBe(40);
  });

  it("stacks ribbons without overlapping inside a node's face", () => {
    const laid = layoutSankey(sankey, 400, 200, columnX, STAGE_ORDER);
    const intoB1 = laid.links.filter((l) => l.target.key === "b1");
    expect(intoB1).toHaveLength(2);
    const total = intoB1.reduce((sum, l) => sum + l.thickness, 0);
    // The two incoming bands together fill exactly the node they land on.
    expect(total).toBeCloseTo(
      laid.nodes.find((n) => n.key === "b1")!.height,
      5,
    );
  });

  it("never lets bands overflow the node they leave", () => {
    // With a small scale a per-link minimum thickness would make the bands
    // leaving a node sum to more than the node is tall — geometry claiming
    // more sessions than the node it grew out of contains. A band too thin to
    // see is honest; one that overflows its source is not.
    const many: InsightsSankey = {
      nodes: [
        node("goal", "g1", 1000),
        ...Array.from({ length: 30 }, (_, i) => node("behavior", `b${i}`, 1)),
      ],
      links: Array.from({ length: 30 }, (_, i) => ({
        source: "goal:g1",
        target: `behavior:b${i}`,
        count: 1,
      })),
      foldedGoalCount: 0,
      foldedByStage: {},
    };
    const laid = layoutSankey(many, 400, 200, columnX, STAGE_ORDER);
    const g1 = laid.nodes.find((n) => n.key === "g1")!;
    const outgoing = laid.links.reduce((sum, l) => sum + l.thickness, 0);
    expect(outgoing).toBeLessThanOrEqual(g1.height + 1e-6);
  });

  it("echoes the column positions back for the headers to share", () => {
    // The headers are drawn from these exact numbers. They used to be a CSS
    // grid across the panel while the chart was a fixed-width box, so on a wide
    // panel the last header sat hundreds of pixels from its own column. One
    // coordinate space is the only thing that keeps them together.
    const laid = layoutSankey(sankey, 400, 200, columnX, STAGE_ORDER);
    expect(laid.columnX).toEqual(columnX);
    for (const stage of ["goal", "behavior", "outcome", "sentiment"] as const) {
      const inStage = laid.nodes.filter((n) => n.stage === stage);
      if (inStage.length === 0) continue;
      const index = ["goal", "behavior", "outcome", "sentiment"].indexOf(stage);
      expect(inStage.every((n) => n.x === laid.columnX[index])).toBe(true);
    }
  });

  it("drops a link whose endpoint is not drawn", () => {
    const orphaned: InsightsSankey = {
      ...sankey,
      links: [
        ...sankey.links,
        { source: "goal:g1", target: "behavior:ghost", count: 1 },
      ],
    };
    expect(
      layoutSankey(orphaned, 400, 200, columnX, STAGE_ORDER).links,
    ).toHaveLength(4);
  });

  it("survives an empty diagram without dividing by zero", () => {
    const empty = layoutSankey(
      { nodes: [], links: [], foldedGoalCount: 0, foldedByStage: {} },
      400,
      200,
      columnX,
      STAGE_ORDER,
    );
    expect(empty.nodes).toEqual([]);
    expect(empty.links).toEqual([]);
  });
});

describe("stageTotal", () => {
  it("sums a stage", () => {
    const sankey: InsightsSankey = {
      nodes: [node("outcome", "o1", 3), node("outcome", "o2", 1)],
      links: [],
      foldedGoalCount: 0,
      foldedByStage: {},
    };
    expect(stageTotal(sankey, "outcome")).toBe(4);
    expect(stageTotal(sankey, "goal")).toBe(0);
  });
});
