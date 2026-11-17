import { describe, expect, it } from "vitest";
import {
  CARD_WIDTH,
  ROOT_NODE_ID,
  TRUNK_X,
  initialViewNodeIds,
  layoutServerCanvas,
} from "../server-canvas-layout";

const ALL_CARDS = [
  "server-info",
  "base-protocol",
  "server-features",
  "server-utilities",
  "client-features",
  "authorization",
  "extensions",
  "third-party",
] as const;

function cards(ids: readonly (typeof ALL_CARDS)[number][] = ALL_CARDS) {
  return ids.map((id) => ({ id, estimatedHeight: 200 }));
}

describe("layoutServerCanvas", () => {
  it("centres the root over the trunk and splits the cards into two columns", () => {
    const { nodes } = layoutServerCanvas({ cards: cards(), heights: {} });
    const root = nodes.find((node) => node.id === ROOT_NODE_ID);
    expect(root?.x).toBe(TRUNK_X - CARD_WIDTH / 2);
    const left = nodes.filter((node) => node.side === "left").map((n) => n.id);
    const right = nodes.filter((node) => node.side === "right").map((n) => n.id);
    expect(left).toEqual([
      "server-info",
      "base-protocol",
      "server-utilities",
      "client-features",
      "authorization",
    ]);
    expect(right).toEqual(["server-features", "extensions", "third-party"]);
  });

  it("joins each card to the trunk with a level stub", () => {
    const { nodes, edges } = layoutServerCanvas({ cards: cards(), heights: {} });
    for (const node of nodes.filter((n) => n.side)) {
      const stub = edges.find((edge) => edge.id === `stub:${node.id}`);
      expect(stub?.data.fixedSourceX).toBe(TRUNK_X);
      expect(stub?.data.fixedSourceY).toBe(stub?.data.fixedTargetY);
      expect(stub?.data.fixedTargetX).toBe(
        node.side === "left" ? CARD_WIDTH : node.x,
      );
    }
    const trunk = edges.find((edge) => edge.id === "trunk");
    const lowest = Math.max(
      ...edges.filter((e) => e.id !== "trunk").map((e) => e.data.fixedSourceY),
    );
    expect(trunk?.data.fixedSourceX).toBe(trunk?.data.fixedTargetX);
    expect(trunk?.data.fixedTargetY).toBe(lowest);
  });

  it("moves the cards below a measured card by its real height", () => {
    const before = layoutServerCanvas({ cards: cards(), heights: {} });
    const after = layoutServerCanvas({
      cards: cards(),
      heights: { "base-protocol": 500 },
    });
    const y = (layout: typeof before, id: string) =>
      layout.nodes.find((node) => node.id === id)?.y ?? 0;
    expect(y(after, "base-protocol")).toBe(y(before, "base-protocol"));
    expect(y(after, "server-utilities") - y(before, "server-utilities")).toBe(300);
    expect(y(after, "extensions")).toBe(y(before, "extensions"));
  });

  it("closes the gap left by a card that is filtered out", () => {
    const { nodes, edges } = layoutServerCanvas({
      cards: cards(["base-protocol", "extensions"]),
      heights: {},
    });
    expect(nodes.map((node) => node.id)).toEqual([
      ROOT_NODE_ID,
      "base-protocol",
      "extensions",
    ]);
    expect(nodes[1].y).toBe(nodes[2].y);
    expect(edges.map((edge) => edge.id)).toEqual([
      "trunk",
      "stub:base-protocol",
      "stub:extensions",
    ]);
  });
});

describe("initialViewNodeIds", () => {
  it("fits the root and the top card of each column", () => {
    expect(initialViewNodeIds([...ALL_CARDS])).toEqual([
      ROOT_NODE_ID,
      "server-info",
      "server-features",
    ]);
    expect(initialViewNodeIds(["extensions"])).toEqual([
      ROOT_NODE_ID,
      "extensions",
    ]);
  });
});
