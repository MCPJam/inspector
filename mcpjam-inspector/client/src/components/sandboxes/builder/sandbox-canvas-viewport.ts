import type { SandboxFlowNode } from "./types";

/** Keep in sync with builder node card width (`SandboxCanvas` / `sandboxCanvasBuilder`). */
export const SANDBOX_BUILDER_NODE_WIDTH = 280;
export const SANDBOX_BUILDER_NODE_HEIGHT = 128;

interface SandboxCanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function getNodeDimensions(node: SandboxFlowNode): {
  width: number;
  height: number;
} {
  switch (node.type) {
    case "sandboxNode":
      return {
        width: SANDBOX_BUILDER_NODE_WIDTH,
        height: SANDBOX_BUILDER_NODE_HEIGHT,
      };
    default:
      return { width: 0, height: 0 };
  }
}

function getRenderableNodes(nodes: SandboxFlowNode[]) {
  return nodes.filter((node) => node.type === "sandboxNode");
}

export function getSandboxCanvasLayoutSignature(
  nodes: SandboxFlowNode[],
): string {
  return getRenderableNodes(nodes)
    .map((node) => `${node.id}:${node.position.x}:${node.position.y}`)
    .join("|");
}

export function getSandboxCanvasBounds(
  nodes: SandboxFlowNode[],
): SandboxCanvasBounds | null {
  const renderableNodes = getRenderableNodes(nodes);
  if (renderableNodes.length === 0) {
    return null;
  }

  return renderableNodes.reduce<SandboxCanvasBounds>(
    (bounds, node) => {
      const { width, height } = getNodeDimensions(node);
      const minX = Math.min(bounds.minX, node.position.x);
      const minY = Math.min(bounds.minY, node.position.y);
      const maxX = Math.max(bounds.maxX, node.position.x + width);
      const maxY = Math.max(bounds.maxY, node.position.y + height);

      return { minX, minY, maxX, maxY };
    },
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

export function getSandboxCanvasCenter(nodes: SandboxFlowNode[]) {
  const bounds = getSandboxCanvasBounds(nodes);
  if (!bounds) {
    return null;
  }

  return {
    x: bounds.minX + (bounds.maxX - bounds.minX) / 2,
    y: bounds.minY + (bounds.maxY - bounds.minY) / 2,
  };
}
