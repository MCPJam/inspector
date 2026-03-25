import dagre from "@dagrejs/dagre";
import type { ArchNodeDef, ArchEdgeDef } from "./types";
import {
  ARCH_BLOCK_WIDTH,
  ARCH_BLOCK_HEIGHT,
  ARCH_ASSET_CODE_WIDTH,
  ARCH_ASSET_CODE_HEIGHT,
  ARCH_ASSET_IMAGE_WIDTH,
  ARCH_ASSET_IMAGE_HEIGHT,
} from "./constants";

export interface AutoLayoutOptions {
  direction?: "LR" | "TB" | "RL" | "BT";
  nodeSpacing?: number;
  rankSpacing?: number;
}

/**
 * Compute positions for nodes that don't have explicit `position` values.
 * Nodes that already have positions are left unchanged.
 * Uses dagre for hierarchical graph layout.
 */
export function autoLayoutNodes(
  nodes: ArchNodeDef[],
  edges: ArchEdgeDef[],
  options?: AutoLayoutOptions,
): ArchNodeDef[] {
  const {
    direction = "LR",
    nodeSpacing = 60,
    rankSpacing = 120,
  } = options ?? {};

  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({
    rankdir: direction,
    nodesep: nodeSpacing,
    ranksep: rankSpacing,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add all nodes to the graph
  for (const node of nodes) {
    let w: number;
    let h: number;
    if (node.type === "group") {
      w = node.width ?? 400;
      h = node.height ?? 200;
    } else if (node.type === "asset") {
      const kind = node.assetType ?? "code";
      w =
        node.width ??
        (kind === "image" ? ARCH_ASSET_IMAGE_WIDTH : ARCH_ASSET_CODE_WIDTH);
      h =
        node.height ??
        (kind === "image" ? ARCH_ASSET_IMAGE_HEIGHT : ARCH_ASSET_CODE_HEIGHT);
    } else {
      w = ARCH_BLOCK_WIDTH;
      h = ARCH_BLOCK_HEIGHT;
    }
    g.setNode(node.id, { width: w, height: h });

    if (node.parentId) {
      g.setParent(node.id, node.parentId);
    }
  }

  // Add edges
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // Map back — dagre gives center coordinates, React Flow uses top-left
  return nodes.map((node) => {
    if (node.position) return node; // keep explicit positions

    const layoutNode = g.node(node.id);
    if (!layoutNode) return node;

    return {
      ...node,
      position: {
        x: layoutNode.x - layoutNode.width / 2,
        y: layoutNode.y - layoutNode.height / 2,
      },
    };
  });
}
