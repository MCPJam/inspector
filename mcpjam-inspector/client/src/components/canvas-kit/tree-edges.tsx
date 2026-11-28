import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";

/** Corner radius of the trunk that drops from a root card to its hub. */
export const TRUNK_CORNER = 14;
/** Corner radius of the branches that fan out from a hub to its children. */
export const BRANCH_CORNER = 8;

/**
 * Endpoints a canvas builder bakes into `edge.data` for a fixed edge.
 *
 * Fixed edges read their endpoints from here instead of from ReactFlow's
 * measured handle positions. framer-motion's `layout` and `layoutId` morphs
 * change a node's CSS transform, and ReactFlow measures handles with
 * `getBoundingClientRect`, which includes that transform. The measured target
 * can then sit hundreds of pixels from where the node lives in flow
 * coordinates, so one branch flaps to a corner of the canvas. The builder
 * already knows every node's flow coordinates, so it passes them straight
 * through.
 */
export type FixedEdgeData = {
  fixedSourceX: number;
  fixedSourceY: number;
  fixedTargetX: number;
  fixedTargetY: number;
};

export function isFixedEdgeData(data: unknown): data is FixedEdgeData {
  if (data == null || typeof data !== "object") return false;
  const d = data as Partial<Record<keyof FixedEdgeData, unknown>>;
  return (
    typeof d.fixedSourceX === "number" &&
    typeof d.fixedSourceY === "number" &&
    typeof d.fixedTargetX === "number" &&
    typeof d.fixedTargetY === "number"
  );
}

/**
 * An SVG path for a tree connector: straight down from the source, a rounded
 * turn into a horizontal run at the midpoint, and a rounded turn down into the
 * target. Vertically aligned endpoints give a single straight line.
 */
export function buildOrthogonalTreePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  cornerRadius: number,
): string {
  const midY = (sourceY + targetY) / 2;
  const goingRight = targetX >= sourceX;
  const dirX = goingRight ? 1 : -1;
  const r = Math.min(
    cornerRadius,
    Math.abs(targetX - sourceX) / 2,
    Math.abs(midY - sourceY),
    Math.abs(targetY - midY),
  );
  if (r <= 0.5) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${midY - r}`,
    `Q ${sourceX} ${midY} ${sourceX + r * dirX} ${midY}`,
    `L ${targetX - r * dirX} ${midY}`,
    `Q ${targetX} ${midY} ${targetX} ${midY + r}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}

/** A tree edge drawn between the endpoints baked into its `FixedEdgeData`. */
export function makeFixedTreeEdge(cornerRadius: number) {
  return function FixedTreeEdge({ id, data, style, markerEnd }: EdgeProps) {
    if (!isFixedEdgeData(data)) return null;
    const path = buildOrthogonalTreePath(
      data.fixedSourceX,
      data.fixedSourceY,
      data.fixedTargetX,
      data.fixedTargetY,
      cornerRadius,
    );
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
  };
}

/** Hub-to-child branch with the builder's fixed endpoints. */
export const TreeBranchEdge = makeFixedTreeEdge(BRANCH_CORNER);

/**
 * Root-to-hub trunk drawn between ReactFlow's measured handle positions, so
 * the line tracks the root card's rendered bottom rather than the builder's
 * height estimate.
 *
 * Use it only between nodes without a persistent `layout`/`layoutId` morph.
 * A one-time mount reveal settles to an identity transform, so the measured
 * positions are right in steady state; a node that keeps morphing needs
 * `TreeBranchEdge` and fixed coordinates instead.
 */
export function TreeTrunkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
}: EdgeProps) {
  const path = buildOrthogonalTreePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    TRUNK_CORNER,
  );
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

/**
 * Move the fixed endpoints of the edges `shouldShift` selects down by `dy`.
 * Returns the same array when `dy` is 0, and the same edge for every edge
 * that is not selected or carries no fixed endpoints.
 */
export function shiftFixedEdgesY(
  edges: Edge[],
  dy: number,
  shouldShift: (edge: Edge) => boolean,
): Edge[] {
  if (dy === 0) return edges;
  return edges.map((edge) => {
    if (!shouldShift(edge) || !isFixedEdgeData(edge.data)) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        fixedSourceY: edge.data.fixedSourceY + dy,
        fixedTargetY: edge.data.fixedTargetY + dy,
      },
    };
  });
}
