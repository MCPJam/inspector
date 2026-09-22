import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InsightsSankey } from "@/hooks/useUsageInsights";
import { FlowSankeyDiagram } from "../flow-sankey-diagram";
import { SANKEY_UNLABELED } from "../insights-sankey";

const STAGES = ["case", "route", "reason"] as const;
type Stage = (typeof STAGES)[number];

const TITLES: Record<Stage, string> = {
  case: "Case",
  route: "Route",
  reason: "Reason",
};

const COLORS: Record<Stage, { node: string; head: string }> = {
  case: { node: "var(--diagram-view)", head: "var(--diagram-view)" },
  route: { node: "var(--diagram-server)", head: "var(--diagram-server)" },
  reason: { node: "var(--destructive)", head: "var(--destructive)" },
};

const SANKEY: InsightsSankey<Stage> = {
  nodes: [
    {
      id: "case:a",
      stage: "case",
      key: "a",
      label: "Look up a user",
      count: 3,
      clickable: true,
    },
    {
      id: "route:search",
      stage: "route",
      key: "search",
      label: "search",
      count: 3,
      clickable: true,
    },
    {
      id: "reason:g0",
      stage: "reason",
      key: "g0",
      label: "Skipped the lookup",
      count: 3,
      clickable: true,
    },
  ],
  links: [
    { source: "case:a", target: "route:search", count: 3 },
    {
      source: "route:search",
      target: "reason:g0",
      count: 3,
      discordantCount: 3,
    },
  ],
  foldedGoalCount: 0,
};

describe("FlowSankeyDiagram", () => {
  it("draws three column headers at their own column x", () => {
    render(
      <FlowSankeyDiagram
        sankey={SANKEY}
        stages={STAGES}
        stageTitles={TITLES}
        stageColors={COLORS}
        unitNoun="trials"
        ariaLabel="Failed trials from case through route to reason"
      />,
    );

    const headers = Array.from(document.querySelectorAll("text")).filter((t) =>
      ["CASE", "ROUTE", "REASON"].includes((t.textContent ?? "").toUpperCase()),
    );
    expect(headers).toHaveLength(3);
    const xs = headers.map((h) => Number(h.getAttribute("x")));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(3);
    expect(
      screen.getByRole("group", {
        name: /Failed trials from case through route to reason/,
      }),
    ).toBeInTheDocument();
  });

  it("does not paint a discordant warning gradient when highlight is off", () => {
    render(
      <FlowSankeyDiagram
        sankey={SANKEY}
        stages={STAGES}
        stageTitles={TITLES}
        stageColors={COLORS}
        unitNoun="trials"
        ariaLabel="Failed trials from case through route to reason"
      />,
    );

    const stops = Array.from(document.querySelectorAll("stop"));
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(stop.getAttribute("stop-color")).not.toBe("var(--warning)");
    }
    expect(
      screen.queryByRole("img", {
        name: /outcome and sentiment disagree/,
      }),
    ).toBeNull();
  });

  it("draws every node at full weight when no selection model is passed", () => {
    render(
      <FlowSankeyDiagram
        sankey={SANKEY}
        stages={STAGES}
        stageTitles={TITLES}
        stageColors={COLORS}
        unitNoun="trials"
        ariaLabel="Failed trials from case through route to reason"
      />,
    );
    const rects = Array.from(document.querySelectorAll("rect"));
    expect(rects).toHaveLength(3);
    for (const rect of rects) {
      expect(rect.getAttribute("fill-opacity")).toBe("1");
    }
  });

  it("dims only the node the selection model refuses", () => {
    const withSentinel: InsightsSankey<Stage> = {
      ...SANKEY,
      nodes: [
        ...SANKEY.nodes,
        {
          id: `reason:${SANKEY_UNLABELED}`,
          stage: "reason",
          key: SANKEY_UNLABELED,
          label: "Not judged",
          count: 1,
          clickable: true,
        },
      ],
      links: [
        ...SANKEY.links,
        {
          source: "route:search",
          target: `reason:${SANKEY_UNLABELED}`,
          count: 1,
        },
      ],
    };
    render(
      <FlowSankeyDiagram
        sankey={withSentinel}
        stages={STAGES}
        stageTitles={TITLES}
        stageColors={COLORS}
        unitNoun="trials"
        ariaLabel="Failed trials from case through route to reason"
        onSelectNode={() => {}}
        labelForNode={(node) => node.label}
        isSelectable={(node) => node.clickable && node.key !== SANKEY_UNLABELED}
      />,
    );
    const refused = screen
      .getByRole("img", { name: /^Not judged,/ })
      .querySelector("rect");
    expect(refused?.getAttribute("fill-opacity")).toBe("0.45");
    const kept = screen
      .getByRole("button", { name: /^Look up a user,/ })
      .querySelector("rect");
    expect(kept?.getAttribute("fill-opacity")).toBe("1");
  });

  it("gives every gradient its own id across links and diagram instances", () => {
    // `route:a:b` and `route:a_b` sanitize to the same name; two instances
    // of the same diagram would otherwise share every id.
    const colliding: InsightsSankey<Stage> = {
      nodes: [
        {
          id: "case:x",
          stage: "case",
          key: "x",
          label: "X",
          count: 2,
          clickable: true,
        },
        {
          id: "route:a:b",
          stage: "route",
          key: "a:b",
          label: "a:b",
          count: 1,
          clickable: true,
        },
        {
          id: "route:a_b",
          stage: "route",
          key: "a_b",
          label: "a_b",
          count: 1,
          clickable: true,
        },
        {
          id: "reason:g0",
          stage: "reason",
          key: "g0",
          label: "R",
          count: 2,
          clickable: true,
        },
      ],
      links: [
        { source: "case:x", target: "route:a:b", count: 1 },
        { source: "case:x", target: "route:a_b", count: 1 },
        { source: "route:a:b", target: "reason:g0", count: 1 },
        { source: "route:a_b", target: "reason:g0", count: 1 },
      ],
      foldedGoalCount: 0,
    };
    const diagram = (
      <FlowSankeyDiagram
        sankey={colliding}
        stages={STAGES}
        stageTitles={TITLES}
        stageColors={COLORS}
        unitNoun="trials"
        ariaLabel="Failed trials from case through route to reason"
      />
    );
    render(
      <>
        {diagram}
        {diagram}
      </>,
    );
    const ids = Array.from(document.querySelectorAll("linearGradient")).map(
      (gradient) => gradient.getAttribute("id"),
    );
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    const fills = Array.from(document.querySelectorAll("path")).map((path) =>
      path.getAttribute("fill"),
    );
    expect(fills).toHaveLength(8);
    for (const fill of fills) {
      const match = /^url\(#(.+)\)$/.exec(fill ?? "");
      expect(match).not.toBeNull();
      expect(ids).toContain(match![1]);
    }
  });

  it("lets the caller refuse a clickable sentinel, which is then not a button", () => {
    const withSentinel: InsightsSankey<Stage> = {
      ...SANKEY,
      nodes: [
        ...SANKEY.nodes,
        {
          id: `reason:${SANKEY_UNLABELED}`,
          stage: "reason",
          key: SANKEY_UNLABELED,
          label: "Not judged",
          count: 1,
          clickable: true,
        },
      ],
      links: [
        ...SANKEY.links,
        {
          source: "route:search",
          target: `reason:${SANKEY_UNLABELED}`,
          count: 1,
        },
      ],
    };
    render(
      <FlowSankeyDiagram
        sankey={withSentinel}
        stages={STAGES}
        stageTitles={TITLES}
        stageColors={COLORS}
        unitNoun="trials"
        ariaLabel="Failed trials from case through route to reason"
        onSelectNode={() => {}}
        onSelectLink={() => {}}
        labelForNode={(node) => node.label}
        isSelectable={(node) => node.clickable && node.key !== SANKEY_UNLABELED}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Not judged,/ })).toBeNull();
    expect(
      screen.getByRole("img", { name: /^Not judged,.*not selectable/ }),
    ).toBeInTheDocument();
    // The link into it is refused too, by the default link rule.
    expect(
      screen.queryByRole("button", { name: /search to Not judged/ }),
    ).toBeNull();
    // A selectable node is still a button.
    expect(
      screen.getByRole("button", { name: /^Look up a user,/ }),
    ).toBeInTheDocument();
  });
});
