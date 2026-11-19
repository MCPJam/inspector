import type { FeatureCardId } from "@mcpjam/sdk/browser";
import type { FixedEdgeData } from "@/components/canvas-kit/tree-edges";

/*
 * The canvas is the root card over a vertical trunk with the section cards in
 * two columns either side of it, each joined to the trunk by a short stub.
 * Card heights depend on which families are expanded, so the builder takes
 * measured heights and falls back to an estimate until a card is measured.
 */

export const ROOT_NODE_ID = "server-root";
export const CARD_WIDTH = 380;
const COLUMN_GAP = 72;
const CARD_GAP = 28;
const ROOT_GAP = 48;
/** Where a stub meets its card: level with the card title. */
const STUB_OFFSET = 26;
const ROOT_ESTIMATE = 96;

/** Left column, then right, in the spec's section order. */
const COLUMNS: readonly [readonly FeatureCardId[], readonly FeatureCardId[]] = [
  [
    "server-info",
    "base-protocol",
    "server-utilities",
    "client-features",
    "authorization",
  ],
  ["server-features", "extensions", "third-party"],
];

export const TRUNK_X = CARD_WIDTH + COLUMN_GAP / 2;
const RIGHT_X = CARD_WIDTH + COLUMN_GAP;

/** A collapsed card: header plus one row per family. */
export function estimateCardHeight(familyCount: number): number {
  return 96 + familyCount * 46;
}

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  /** Which side of the trunk a card sits on; the root has none. */
  side?: "left" | "right";
}

export interface LaidOutEdge {
  id: string;
  source: string;
  target: string;
  data: FixedEdgeData;
}

export function layoutServerCanvas({
  cards,
  heights,
}: {
  /** Cards to draw with their estimated heights; absent cards are skipped. */
  cards: ReadonlyArray<{ id: FeatureCardId; estimatedHeight: number }>;
  /** Measured heights by node id, the root's included. */
  heights: Readonly<Record<string, number>>;
}): { nodes: LaidOutNode[]; edges: LaidOutEdge[] } {
  const rootHeight = heights[ROOT_NODE_ID] ?? ROOT_ESTIMATE;
  const rootBottom = rootHeight;
  const nodes: LaidOutNode[] = [{ id: ROOT_NODE_ID, x: 0, y: 0 }];
  const edges: LaidOutEdge[] = [];
  const estimate = new Map(cards.map((card) => [card.id, card.estimatedHeight]));
  let lowestStub = rootBottom;
  let lastCard: string | null = null;

  COLUMNS.forEach((column, index) => {
    const side = index === 0 ? "left" : "right";
    let y = rootBottom + ROOT_GAP;
    for (const id of column) {
      const estimated = estimate.get(id);
      if (estimated === undefined) continue;
      const x = side === "left" ? 0 : RIGHT_X;
      nodes.push({ id, x, y, side });
      const stubY = y + STUB_OFFSET;
      edges.push({
        id: `stub:${id}`,
        source: ROOT_NODE_ID,
        target: id,
        data: {
          fixedSourceX: TRUNK_X,
          fixedSourceY: stubY,
          fixedTargetX: side === "left" ? CARD_WIDTH : RIGHT_X,
          fixedTargetY: stubY,
        },
      });
      if (stubY > lowestStub) {
        lowestStub = stubY;
        lastCard = id;
      }
      y += (heights[id] ?? estimated) + CARD_GAP;
    }
  });

  // The root is centred over the trunk.
  nodes[0] = { id: ROOT_NODE_ID, x: TRUNK_X - CARD_WIDTH / 2, y: 0 };
  if (lastCard) {
    edges.unshift({
      id: "trunk",
      source: ROOT_NODE_ID,
      target: lastCard,
      data: {
        fixedSourceX: TRUNK_X,
        fixedSourceY: rootBottom,
        fixedTargetX: TRUNK_X,
        fixedTargetY: lowestStub,
      },
    });
  }
  return { nodes, edges };
}

/** The nodes the first view fits: the root and the top card of each column. */
export function initialViewNodeIds(cardIds: readonly FeatureCardId[]): string[] {
  const present = new Set(cardIds);
  const firstOf = (column: readonly FeatureCardId[]) =>
    column.find((id) => present.has(id));
  return [ROOT_NODE_ID, firstOf(COLUMNS[0]), firstOf(COLUMNS[1])].filter(
    (id): id is string => id !== undefined,
  );
}
