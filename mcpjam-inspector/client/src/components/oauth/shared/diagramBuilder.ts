import type { Node, Edge } from "@xyflow/react";
import {
  ACTORS,
  ACTOR_X_POSITIONS,
  ACTION_SPACING,
  SEGMENT_HEIGHT,
} from "./constants";
import { getActionStatus } from "./utils";
import type { Action, ActorNodeData } from "./types";

export interface DiagramActorConfig {
  actors: Record<string, { label: string; color: string }>;
  actorXPositions: Record<string, number>;
}

export function buildNodesAndEdges(
  actions: Action[],
  currentStep: string,
  config: DiagramActorConfig = {
    actors: ACTORS,
    actorXPositions: ACTOR_X_POSITIONS,
  },
): { nodes: Node[]; edges: Edge[] } {
  const totalActions = actions.length;
  const totalSegmentHeight = totalActions * ACTION_SPACING + 100;
  const actorIds = Object.keys(config.actors);

  const actorSegments = Object.fromEntries(
    actorIds.map((actorId) => [actorId, [] as ActorNodeData["segments"]]),
  ) as Record<string, ActorNodeData["segments"]>;

  let currentY = 0;

  actions.forEach((action, index) => {
    const actionY = index * ACTION_SPACING;

    // Add line segments before the action
    if (currentY < actionY) {
      const lineHeight = actionY - currentY;
      actorIds.forEach((actorId) => {
        actorSegments[actorId].push({
          id: `${actorId}-line-${index}`,
          type: "line",
          height: lineHeight,
        });
      });
      currentY = actionY;
    }

    // Add box segments for the actors involved in this action
    const addSegmentForActor = (
      actorName: string,
      segments: ActorNodeData["segments"],
    ) => {
      if (action.from === actorName || action.to === actorName) {
        segments.push({
          id: `${actorName}-box-${action.id}`,
          type: "box",
          height: SEGMENT_HEIGHT,
          handleId: action.id,
        });
      } else {
        segments.push({
          id: `${actorName}-line-action-${index}`,
          type: "line",
          height: SEGMENT_HEIGHT,
        });
      }
    };

    actorIds.forEach((actorId) => {
      addSegmentForActor(actorId, actorSegments[actorId]);
    });

    currentY += SEGMENT_HEIGHT;
  });

  // Add final line segments
  const remainingHeight = totalSegmentHeight - currentY;
  if (remainingHeight > 0) {
    actorIds.forEach((actorId) => {
      actorSegments[actorId].push({
        id: `${actorId}-line-end`,
        type: "line",
        height: remainingHeight,
      });
    });
  }

  const nodes: Node[] = actorIds.map((actorId) => ({
    id: `actor-${actorId}`,
    type: "actor",
    position: { x: config.actorXPositions[actorId] ?? 0, y: 0 },
    data: {
      label: config.actors[actorId]?.label ?? actorId,
      color: config.actors[actorId]?.color ?? "#94a3b8",
      totalHeight: totalSegmentHeight,
      segments: actorSegments[actorId],
    },
    draggable: false,
  }));

  // Create action edges
  const edges: Edge[] = actions.map((action) => {
    const status = getActionStatus(action.id, currentStep, actions);
    const isComplete = status === "complete";
    const isCurrent = status === "current";
    const isPending = status === "pending";

    const arrowColor = isComplete
      ? "#10b981"
      : isCurrent
        ? "#3b82f6"
        : "#d1d5db";

    const sourceX = config.actorXPositions[action.from] ?? 0;
    const targetX = config.actorXPositions[action.to] ?? 0;
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
