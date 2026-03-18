import type { Node, Edge } from "@xyflow/react";
import { ACTION_SPACING, SEGMENT_HEIGHT } from "./constants";
import { getActionStatus } from "./utils";
import type {
  SequenceDiagramActorConfig,
  SequenceDiagramAction,
  ActorNodeData,
  NodeStatus,
} from "./types";

interface BuildNodesAndEdgesParams {
  actors: SequenceDiagramActorConfig[];
  actions: SequenceDiagramAction[];
  /** When undefined, all edges get "neutral" status (static educational view) */
  currentStep?: string;
  /** Required — explicit x-positions keyed by actor id */
  actorXPositions: Record<string, number>;
}

export function buildNodesAndEdges({
  actors,
  actions,
  currentStep,
  actorXPositions,
}: BuildNodesAndEdgesParams): { nodes: Node[]; edges: Edge[] } {
  const totalActions = actions.length;
  const totalSegmentHeight = totalActions * ACTION_SPACING + 100;

  // Create segment arrays dynamically for each actor
  const segmentsByActor: Record<string, ActorNodeData["segments"]> = {};
  for (const actor of actors) {
    segmentsByActor[actor.id] = [];
  }

  let currentY = 0;

  actions.forEach((action, index) => {
    const actionY = index * ACTION_SPACING;

    // Add line segments before the action for all actors
    if (currentY < actionY) {
      const lineHeight = actionY - currentY;
      for (const actor of actors) {
        segmentsByActor[actor.id].push({
          id: `${actor.id}-line-${index}`,
          type: "line",
          height: lineHeight,
        });
      }
      currentY = actionY;
    }

    // Add box segments for involved actors, line segments for others
    for (const actor of actors) {
      if (action.from === actor.id || action.to === actor.id) {
        segmentsByActor[actor.id].push({
          id: `${actor.id}-box-${action.id}`,
          type: "box",
          height: SEGMENT_HEIGHT,
          handleId: action.id,
        });
      } else {
        segmentsByActor[actor.id].push({
          id: `${actor.id}-line-action-${index}`,
          type: "line",
          height: SEGMENT_HEIGHT,
        });
      }
    }

    currentY += SEGMENT_HEIGHT;
  });

  // Add final line segments
  const remainingHeight = totalSegmentHeight - currentY;
  if (remainingHeight > 0) {
    for (const actor of actors) {
      segmentsByActor[actor.id].push({
        id: `${actor.id}-line-end`,
        type: "line",
        height: remainingHeight,
      });
    }
  }

  // Create actor nodes dynamically
  const nodes: Node[] = actors.map((actor) => ({
    id: `actor-${actor.id}`,
    type: "actor",
    position: { x: actorXPositions[actor.id] ?? 0, y: 0 },
    data: {
      label: actor.label,
      color: actor.color,
      totalHeight: totalSegmentHeight,
      segments: segmentsByActor[actor.id],
    },
    draggable: false,
  }));

  // Create action edges
  const edges: Edge[] = actions.map((action) => {
    // When currentStep is undefined → "neutral" (static view)
    const status: NodeStatus =
      currentStep === undefined
        ? "neutral"
        : getActionStatus(action.id, currentStep, actions);

    const isComplete = status === "complete";
    const isCurrent = status === "current";
    const isPending = status === "pending";
    const isNeutral = status === "neutral";

    const arrowColor = isComplete
      ? "#10b981"
      : isCurrent
        ? "#3b82f6"
        : isNeutral
          ? "#94a3b8"
          : "#d1d5db";

    const sourceX = actorXPositions[action.from] ?? 0;
    const targetX = actorXPositions[action.to] ?? 0;
    const isLeftToRight = sourceX < targetX;

    return {
      id: `edge-${action.id}`,
      source: `actor-${action.from}`,
      target: `actor-${action.to}`,
      sourceHandle: isLeftToRight
        ? `${action.id}-right-source`
        : `${action.id}-left-source`,
      targetHandle: isLeftToRight
        ? `${action.id}-left-target`
        : `${action.id}-right-target`,
      type: "actionEdge",
      data: {
        stepId: action.id,
        label: action.label,
        description: action.description,
        status,
        details: action.details,
      },
      animated: isCurrent,
      markerEnd: {
        type: "arrowclosed" as const,
        color: arrowColor,
        width: 12,
        height: 12,
      },
      style: {
        stroke: arrowColor,
        strokeWidth: isCurrent ? 3 : isComplete ? 2 : 1.5,
        strokeDasharray: isCurrent ? "5,5" : undefined,
        opacity: isPending ? 0.4 : 1,
      },
    };
  });

  return { nodes, edges };
}
