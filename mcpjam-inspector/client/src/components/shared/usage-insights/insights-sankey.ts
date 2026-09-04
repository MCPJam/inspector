import type {
  InsightsSankey,
  InsightsSankeyNode,
  SankeyStage,
} from "@/hooks/useUsageInsights";
import type { InsightsSelection } from "@/hooks/scenario-usage-filters";

/** Mirrors `SANKEY_UNLABELED` / `SANKEY_OTHER` in the backend's `breakdowns.ts`. */
export const SANKEY_UNLABELED = "__unlabeled__";
export const SANKEY_OTHER = "__other__";

export const STAGE_ORDER: readonly SankeyStage[] = [
  "goal",
  "behavior",
  "outcome",
  "sentiment",
];

export const STAGE_TITLES: Record<SankeyStage, string> = {
  goal: "Goal",
  behavior: "Behavior",
  outcome: "Outcome",
  sentiment: "Sentiment",
};

/**
 * What a node is called.
 *
 * For a real theme this is whatever the clustering named it — already written
 * for people, so it is passed through untouched. Only the two sentinels get
 * text from here, because neither is a theme.
 */
export function stageValueLabel<S extends string = SankeyStage>(
  node: InsightsSankeyNode<S>,
): string {
  if (node.key === SANKEY_UNLABELED) return "Not analyzed";
  return node.label;
}

export function parseNodeId<S extends string = SankeyStage>(
  id: string,
): { stage: S; key: string } {
  const separator = id.indexOf(":");
  return {
    stage: id.slice(0, separator) as S,
    key: id.slice(separator + 1),
  };
}

/**
 * Whether a link joins an outcome theme to a sentiment theme that disagrees
 * with it, for a meaningful share of the sessions on it.
 *
 * The judgement is the SERVER's, carried on `discordantCount`, and it is made
 * from the closed enums rather than the theme labels. Themes are emergent, so
 * no table here could say whether "Goal reached" and "Frustrated by repeats"
 * disagree — the enums are exactly the fixed vocabulary that question needs.
 *
 * The half threshold keeps a mostly-concordant band from being painted as a
 * finding because one session in forty disagreed.
 */
export const DISCORDANT_LINK_THRESHOLD = 0.5;

export function isDiscordantLink(link: {
  count: number;
  discordantCount?: number;
}): boolean {
  if (!link.count) return false;
  return (link.discordantCount ?? 0) / link.count >= DISCORDANT_LINK_THRESHOLD;
}

/**
 * The filter selection a node click produces, or null when the node cannot be
 * expressed as one.
 *
 * Every stage is a theme now, so every selection is a cluster chip carrying its
 * dimension. The two sentinels are unselectable: `__other__` is a union of
 * themes and `__unlabeled__` is the absence of one, and a cluster chip says
 * neither.
 */
export function selectionForNode(
  node: InsightsSankeyNode<SankeyStage>,
): InsightsSelection | null {
  if (!node.clickable) return null;
  if (node.key === SANKEY_UNLABELED || node.key === SANKEY_OTHER) return null;
  return {
    themes: [{ dimension: node.stage, clusterId: node.key, label: node.label }],
  };
}

/**
 * The selection a link click produces: both endpoints at once, which ANDs
 * across the two dimensions. Null when either endpoint is unselectable, since a
 * half-expressible link would silently widen to the other endpoint alone.
 */
export function selectionForLink(
  source: InsightsSankeyNode<SankeyStage>,
  target: InsightsSankeyNode<SankeyStage>,
): InsightsSelection | null {
  const from = selectionForNode(source);
  const to = selectionForNode(target);
  if (!from || !to) return null;
  return { themes: [...from.themes, ...to.themes] };
}

export type SankeyLayoutNode<S extends string = SankeyStage> =
  InsightsSankeyNode<S> & {
    x: number;
    y: number;
    height: number;
    /** Share of this node's own stage, whole percent. */
    share: number;
  };

export type SankeyLayoutLink<S extends string = SankeyStage> = {
  source: SankeyLayoutNode<S>;
  target: SankeyLayoutNode<S>;
  count: number;
  discordant: boolean;
  /** Ribbon geometry: endpoints and thickness. */
  path: string;
  thickness: number;
};

export type SankeyLayout<S extends string = SankeyStage> = {
  nodes: SankeyLayoutNode<S>[];
  links: SankeyLayoutLink<S>[];
  width: number;
  height: number;
  /** Echoed back so headers can be drawn at the same x as their column. */
  columnX: number[];
};

const NODE_WIDTH = 9;
const NODE_GAP = 15;
const PAD = 10;

/**
 * Lay the diagram out directly rather than through a chart library.
 *
 * Recharts' `Sankey` recomputes its own node order and offers no way to keep a
 * stage's themes in the volume order the server sorted them into, which is the
 * one ordering that means the same thing across scenarios. The geometry is four
 * fixed columns and stacked ribbons — small enough to own, and owning it is
 * what makes the columns predictable.
 */
export function layoutSankey<S extends string = SankeyStage>(
  sankey: InsightsSankey<S>,
  width: number,
  height: number,
  columnX: number[],
  stages: readonly S[] = STAGE_ORDER as readonly S[],
): SankeyLayout<S> {
  const total = stages.reduce(
    (max, stage) =>
      Math.max(
        max,
        sankey.nodes
          .filter((n) => n.stage === stage)
          .reduce((sum, n) => sum + n.count, 0),
      ),
    0,
  );
  const maxNodes = Math.max(
    1,
    ...stages.map(
      (stage) => sankey.nodes.filter((n) => n.stage === stage).length,
    ),
  );
  const scale =
    total > 0 ? (height - PAD * 2 - (maxNodes - 1) * NODE_GAP) / total : 0;

  const laid = new Map<string, SankeyLayoutNode<S>>();
  const outAt = new Map<string, number>();
  const inAt = new Map<string, number>();

  stages.forEach((stage, stageIndex) => {
    const column = sankey.nodes.filter((n) => n.stage === stage);
    const columnTotal = column.reduce((sum, n) => sum + n.count, 0);
    const used =
      column.reduce((sum, n) => sum + n.count * scale, 0) +
      Math.max(0, column.length - 1) * NODE_GAP;
    let y = PAD + (height - PAD * 2 - used) / 2;
    for (const node of column) {
      const nodeHeight = Math.max(2, node.count * scale);
      const entry: SankeyLayoutNode<S> = {
        ...node,
        x: columnX[stageIndex],
        y,
        height: nodeHeight,
        share: columnTotal > 0 ? Math.round((node.count / columnTotal) * 100) : 0,
      };
      laid.set(node.id, entry);
      outAt.set(node.id, y);
      inAt.set(node.id, y);
      y += nodeHeight + NODE_GAP;
    }
  });

  // Ribbons stack in the same order their endpoints do, so bands never cross
  // inside a single node's face.
  const stageIndexOf = (id: string) =>
    stages.indexOf(parseNodeId<S>(id).stage);
  const orderOf = (id: string) => sankey.nodes.findIndex((n) => n.id === id);
  const ordered = [...sankey.links].sort(
    (a, b) =>
      stageIndexOf(a.source) - stageIndexOf(b.source) ||
      orderOf(a.source) - orderOf(b.source) ||
      orderOf(a.target) - orderOf(b.target),
  );

  const links: SankeyLayoutLink<S>[] = [];
  for (const link of ordered) {
    const source = laid.get(link.source);
    const target = laid.get(link.target);
    if (!source || !target) continue;
    // NOT clamped to a minimum. A floor makes the bands leaving a node sum to
    // more than the node is tall whenever `scale` is small, so the diagram
    // claims more sessions than the node it grew out of contains. A ribbon too
    // thin to see is honest; one that overflows its source is not.
    const thickness = link.count * scale;
    const sy = outAt.get(source.id)!;
    const ty = inAt.get(target.id)!;
    outAt.set(source.id, sy + thickness);
    inAt.set(target.id, ty + thickness);

    const x0 = source.x + NODE_WIDTH;
    const x1 = target.x;
    const dx = (x1 - x0) * 0.5;
    links.push({
      source,
      target,
      count: link.count,
      discordant: isDiscordantLink(link),
      thickness,
      path:
        `M${x0},${sy} C${x0 + dx},${sy} ${x1 - dx},${ty} ${x1},${ty}` +
        ` L${x1},${ty + thickness} C${x1 - dx},${ty + thickness} ${x0 + dx},${
          sy + thickness
        } ${x0},${sy + thickness} Z`,
    });
  }

  return { nodes: [...laid.values()], links, width, height, columnX };
}

export const SANKEY_NODE_WIDTH = NODE_WIDTH;

/** Sessions in a stage. Every stage sums to the same total, so any one will do. */
export function stageTotal<S extends string = SankeyStage>(
  sankey: InsightsSankey<S>,
  stage: S,
): number {
  return sankey.nodes
    .filter((node) => node.stage === stage)
    .reduce((sum, node) => sum + node.count, 0);
}
