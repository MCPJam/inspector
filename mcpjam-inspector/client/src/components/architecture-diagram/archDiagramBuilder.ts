import type { Node, Edge } from "@xyflow/react";
import type {
  ArchNodeDef,
  ArchEdgeDef,
  ArchNodeStatus,
  HandlePosition,
  StepHighlightMap,
} from "./types";
import { autoLayoutNodes, type AutoLayoutOptions } from "./autoLayout";

export type LayoutOptions = AutoLayoutOptions;

export interface BuildArchNodesAndEdgesParams {
  nodes: ArchNodeDef[];
  edges: ArchEdgeDef[];
  /** When undefined, all elements get "neutral" status (static view) */
  currentStep?: string;
  /** Ordered list of step IDs for the walkthrough */
  stepOrder?: string[];
  /** Maps each step to which nodes/edges are highlighted */
  stepHighlights?: Record<string, StepHighlightMap>;
  /** Auto-layout options (used when nodes lack positions) */
  layoutOptions?: LayoutOptions;
}

function getElementStatus(
  elementId: string,
  field: "activeNodes" | "activeEdges",
  currentStep: string | undefined,
  stepOrder: string[],
  stepHighlights: Record<string, StepHighlightMap>,
): ArchNodeStatus {
  if (currentStep === undefined) return "neutral";

  const currentIdx = stepOrder.indexOf(currentStep);
  if (currentIdx < 0) return "pending";

  // Check if element is active in the current step
  const currentHighlight = stepHighlights[currentStep];
  if (currentHighlight?.[field]?.includes(elementId)) {
    return "current";
  }

  // Check if element was active in any previous step
  for (let i = 0; i < currentIdx; i++) {
    const stepHighlight = stepHighlights[stepOrder[i]];
    if (stepHighlight?.[field]?.includes(elementId)) {
      return "complete";
    }
  }

  return "pending";
}

/**
 * Infer which handles to use based on relative node positions.
 * Falls back to left-to-right when positions are unavailable.
 */
function inferHandles(
  sourceDef: ArchNodeDef,
  targetDef: ArchNodeDef,
): { sourceHandle: string; targetHandle: string } {
  const sp = sourceDef.position;
  const tp = targetDef.position;

  if (!sp || !tp) {
    return { sourceHandle: "right-source", targetHandle: "left-target" };
  }

  const dx = tp.x - sp.x;
  const dy = tp.y - sp.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "right-source", targetHandle: "left-target" }
      : { sourceHandle: "left-source", targetHandle: "right-target" };
  }
  return dy >= 0
    ? { sourceHandle: "bottom-source", targetHandle: "top-target" }
    : { sourceHandle: "top-source", targetHandle: "bottom-target" };
}

function handleId(side: HandlePosition, type: "source" | "target"): string {
  return `${side}-${type}`;
}

export function buildArchNodesAndEdges({
  nodes: rawNodeDefs,
  edges: edgeDefs,
  currentStep,
  stepOrder = [],
  stepHighlights = {},
  layoutOptions,
}: BuildArchNodesAndEdgesParams): { nodes: Node[]; edges: Edge[] } {
  // Auto-layout nodes that lack positions
  const needsLayout = rawNodeDefs.some((n) => !n.position);
  const nodeDefs = needsLayout
    ? autoLayoutNodes(rawNodeDefs, edgeDefs, layoutOptions)
    : rawNodeDefs;

  // Index node defs by id for handle inference
  const nodeMap = new Map<string, ArchNodeDef>();
  for (const def of nodeDefs) {
    nodeMap.set(def.id, def);
  }

  // Build nodes — groups first, then blocks (React Flow requires parent before child)
  const sortedDefs = [...nodeDefs].sort((a, b) => {
    if (a.type === "group" && b.type !== "group") return -1;
    if (a.type !== "group" && b.type === "group") return 1;
    return 0;
  });

  const nodes: Node[] = sortedDefs.map((def) => {
    const status = getElementStatus(
      def.id,
      "activeNodes",
      currentStep,
      stepOrder,
      stepHighlights,
    );

    const position = def.position ?? { x: 0, y: 0 };

    if (def.type === "group") {
      return {
        id: def.id,
        type: "archGroup",
        position,
        data: {
          label: def.label,
          subtitle: def.subtitle,
          color: def.color,
          status,
          width: def.width ?? 400,
          height: def.height ?? 200,
        },
        draggable: false,
        selectable: false,
        style: { width: def.width ?? 400, height: def.height ?? 200 },
      };
    }

    const base: Node = {
      id: def.id,
      type: "archBlock",
      position,
      data: {
        label: def.label,
        subtitle: def.subtitle,
        icon: def.icon,
        color: def.color,
        status,
        width: def.width,
        height: def.height,
      },
      draggable: false,
    };

    if (def.parentId) {
      base.parentId = def.parentId;
      base.extent = "parent" as const;
    }

    return base;
  });

  // Build edges
  const edges: Edge[] = edgeDefs.map((def) => {
    const status = getElementStatus(
      def.id,
      "activeEdges",
      currentStep,
      stepOrder,
      stepHighlights,
    );

    const strokeColor =
      status === "complete"
        ? "#10b981"
        : status === "current"
          ? "#3b82f6"
          : status === "neutral"
            ? "#94a3b8"
            : "#d1d5db";

    // Determine handle connections
    const sourceDef = nodeMap.get(def.source);
    const targetDef = nodeMap.get(def.target);

    let sourceHandle: string;
    let targetHandle: string;

    if (def.sourceHandle && def.targetHandle) {
      sourceHandle = handleId(def.sourceHandle, "source");
      targetHandle = handleId(def.targetHandle, "target");
    } else if (sourceDef && targetDef) {
      const inferred = inferHandles(sourceDef, targetDef);
      sourceHandle = def.sourceHandle
        ? handleId(def.sourceHandle, "source")
        : inferred.sourceHandle;
      targetHandle = def.targetHandle
        ? handleId(def.targetHandle, "target")
        : inferred.targetHandle;
    } else {
      sourceHandle = "right-source";
      targetHandle = "left-target";
    }

    const edge: Edge = {
      id: def.id,
      source: def.source,
      target: def.target,
      sourceHandle,
      targetHandle,
      type: "archConnection",
      data: {
        stepId: def.id,
        label: def.label,
        status,
        pathType: def.pathType,
      },
      animated: status === "current",
      markerEnd: {
        type: "arrowclosed" as const,
        color: strokeColor,
        width: 10,
        height: 10,
      },
    };

    if (def.bidirectional) {
      edge.markerStart = {
        type: "arrowclosed" as const,
        color: strokeColor,
        width: 10,
        height: 10,
      };
    }

    return edge;
  });

  return { nodes, edges };
}
