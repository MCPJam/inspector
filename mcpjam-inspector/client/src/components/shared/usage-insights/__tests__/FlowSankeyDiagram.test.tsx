import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InsightsSankey } from "@/hooks/useUsageInsights";
import { FlowSankeyDiagram } from "../flow-sankey-diagram";

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
});
