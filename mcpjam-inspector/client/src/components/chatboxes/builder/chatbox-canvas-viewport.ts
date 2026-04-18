import type { ChatboxFlowNode } from "./types";

/** Keep in sync with builder node card width (`ChatboxCanvas` / `chatboxCanvasBuilder`). */
export const CHATBOX_BUILDER_NODE_WIDTH = 280;
export const CHATBOX_BUILDER_NODE_HEIGHT = 128;

/**
 * Extra space below the host card for the dashed connector + add-server control
 * (`ChatboxCanvas` host handle UI extends below the card with `translate-y-full`).
 */
export const CHATBOX_BUILDER_HOST_OVERFLOW_BELOW = 56;

/** Chat / host node id from `buildChatboxCanvas`. */
export const CHATBOX_BUILDER_HOST_NODE_ID = "host";

interface ChatboxCanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function getNodeDimensions(node: ChatboxFlowNode): {
  width: number;
  height: number;
} {
  switch (node.type) {
    case "chatboxNode":
      return {
        width: CHATBOX_BUILDER_NODE_WIDTH,
        height: CHATBOX_BUILDER_NODE_HEIGHT,
      };
    default:
      return { width: 0, height: 0 };
  }
}

function getRenderableNodes(nodes: ChatboxFlowNode[]) {
  return nodes.filter((node) => node.type === "chatboxNode");
}

export function getChatboxBuilderRenderableNodeIds(
  nodes: ChatboxFlowNode[],
): string[] {
  return getRenderableNodes(nodes).map((node) => node.id);
}

export function getChatboxCanvasLayoutSignature(
  nodes: ChatboxFlowNode[],
): string {
  return getRenderableNodes(nodes)
    .map((node) => `${node.id}:${node.position.x}:${node.position.y}`)
    .join("|");
}

export function getChatboxCanvasBounds(
  nodes: ChatboxFlowNode[],
): ChatboxCanvasBounds | null {
  const renderableNodes = getRenderableNodes(nodes);
  if (renderableNodes.length === 0) {
    return null;
  }

  return renderableNodes.reduce<ChatboxCanvasBounds>(
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

/**
 * Static graph bounds for `fitBounds`, including host overflow below the card.
 * Use when React Flow measured bounds are missing or invalid.
 */
export function getChatboxCanvasStaticFitBounds(
  nodes: ChatboxFlowNode[],
): { x: number; y: number; width: number; height: number } | null {
  const bounds = getChatboxCanvasBounds(nodes);
  if (!bounds) {
    return null;
  }
  const rect = {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
  return extendChatboxViewportBoundsForHostOverflow(rect, nodes);
}

/** Widen the fit rect downward when the host node is present (measured RF bounds may omit overflow UI). */
export function extendChatboxViewportBoundsForHostOverflow(
  bounds: { x: number; y: number; width: number; height: number },
  layoutNodes: ChatboxFlowNode[],
): { x: number; y: number; width: number; height: number } {
  const hasHost = layoutNodes.some(
    (n) => n.type === "chatboxNode" && n.id === CHATBOX_BUILDER_HOST_NODE_ID,
  );
  if (!hasHost) {
    return bounds;
  }
  return {
    ...bounds,
    height: bounds.height + CHATBOX_BUILDER_HOST_OVERFLOW_BELOW,
  };
}

export function getChatboxCanvasCenter(nodes: ChatboxFlowNode[]) {
  const bounds = getChatboxCanvasBounds(nodes);
  if (!bounds) {
    return null;
  }

  return {
    x: bounds.minX + (bounds.maxX - bounds.minX) / 2,
    y: bounds.minY + (bounds.maxY - bounds.minY) / 2,
  };
}
