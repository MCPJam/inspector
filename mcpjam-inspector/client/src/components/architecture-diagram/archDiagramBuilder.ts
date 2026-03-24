import type { Node, Edge } from "@xyflow/react";
import type {
  ArchNodeDef,
  ArchEdgeDef,
  ArchNodeStatus,
  StepHighlightMap,
} from "./types";

interface BuildArchNodesAndEdgesParams {
  nodes: ArchNodeDef[];
  edges: ArchEdgeDef[];
  /** When undefined, all elements get "neutral" status (static view) */
  currentStep?: string;
  /** Ordered list of step IDs for the walkthrough */
  stepOrder?: string[];
  /** Maps each step to which nodes/edges are highlighted */
  stepHighlights?: Record<string, StepHighlightMap>;
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

export function buildArchNodesAndEdges({
  nodes: nodeDefs,
  edges: edgeDefs,
  currentStep,
  stepOrder = [],
  stepHighlights = {},
}: BuildArchNodesAndEdgesParams): { nodes: Node[]; edges: Edge[] } {
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

    if (def.type === "group") {
      return {
        id: def.id,
        type: "archGroup",
        position: def.position,
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
      position: def.position,
      data: {
        label: def.label,
        subtitle: def.subtitle,
        icon: def.icon,
        color: def.color,
        status,
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

    return {
      id: def.id,
      source: def.source,
      target: def.target,
      type: "archConnection",
      data: {
        stepId: def.id,
        label: def.label,
        status,
      },
      animated: status === "current",
      markerEnd: {
        type: "arrowclosed" as const,
        color: strokeColor,
        width: 10,
        height: 10,
      },
    };
  });

  return { nodes, edges };
}
