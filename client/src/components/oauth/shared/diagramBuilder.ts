import type { Node, Edge } from "@xyflow/react";
import type { OAuthFlowStep } from "@/lib/oauth/state-machines/types";
import {
  ACTORS,
  ACTOR_X_POSITIONS,
  ACTION_SPACING,
  SEGMENT_HEIGHT,
} from "./constants";
import { getActionStatus } from "./utils";
import type { Action, ActorNodeData } from "./types";

export function buildNodesAndEdges(
  actions: Action[],
  currentStep: OAuthFlowStep,
): { nodes: Node[]; edges: Edge[] } {
  const totalActions = actions.length;
  const totalSegmentHeight = totalActions * ACTION_SPACING + 100;

  // Create segments for each actor
  const browserSegments: ActorNodeData["segments"] = [];
  const clientSegments: ActorNodeData["segments"] = [];
  const mcpServerSegments: ActorNodeData["segments"] = [];
  const authServerSegments: ActorNodeData["segments"] = [];

  let currentY = 0;

  actions.forEach((action, index) => {
    const actionY = index * ACTION_SPACING;

    // Add line segments before the action
    if (currentY < actionY) {
      const lineHeight = actionY - currentY;
      browserSegments.push({
        id: `browser-line-${index}`,
        type: "line",
        height: lineHeight,
      });
      clientSegments.push({
        id: `client-line-${index}`,
        type: "line",
        height: lineHeight,
      });
      mcpServerSegments.push({
        id: `mcp-line-${index}`,
        type: "line",
        height: lineHeight,
      });
      authServerSegments.push({
        id: `auth-line-${index}`,
        type: "line",
        height: lineHeight,
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

    addSegmentForActor("browser", browserSegments);
    addSegmentForActor("client", clientSegments);
    addSegmentForActor("mcpServer", mcpServerSegments);
    addSegmentForActor("authServer", authServerSegments);

    currentY += SEGMENT_HEIGHT;
  });

  // Add final line segments
  const remainingHeight = totalSegmentHeight - currentY;
  if (remainingHeight > 0) {
    browserSegments.push({
      id: "browser-line-end",
      type: "line",
      height: remainingHeight,
    });
    clientSegments.push({
      id: "client-line-end",
      type: "line",
      height: remainingHeight,
    });
    mcpServerSegments.push({
      id: "mcp-line-end",
      type: "line",
      height: remainingHeight,
    });
    authServerSegments.push({
      id: "auth-line-end",
      type: "line",
      height: remainingHeight,
    });
  }

  // Create actor nodes
  const nodes: Node[] = [
    {
      id: "actor-browser",
      type: "actor",
      position: { x: ACTOR_X_POSITIONS.browser, y: 0 },
      data: {
        label: ACTORS.browser.label,
        color: ACTORS.browser.color,
        totalHeight: totalSegmentHeight,
        segments: browserSegments,
      },
      draggable: false,
    },
    {
      id: "actor-client",
      type: "actor",
      position: { x: ACTOR_X_POSITIONS.client, y: 0 },
      data: {
        label: ACTORS.client.label,
        color: ACTORS.client.color,
        totalHeight: totalSegmentHeight,
        segments: clientSegments,
      },
      draggable: false,
    },
    {
      id: "actor-mcpServer",
      type: "actor",
      position: { x: ACTOR_X_POSITIONS.mcpServer, y: 0 },
      data: {
        label: ACTORS.mcpServer.label,
        color: ACTORS.mcpServer.color,
        totalHeight: totalSegmentHeight,
        segments: mcpServerSegments,
      },
      draggable: false,
    },
    {
      id: "actor-authServer",
      type: "actor",
      position: { x: ACTOR_X_POSITIONS.authServer, y: 0 },
      data: {
        label: ACTORS.authServer.label,
        color: ACTORS.authServer.color,
        totalHeight: totalSegmentHeight,
        segments: authServerSegments,
      },
      draggable: false,
    },
  ];

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

    const sourceX =
      ACTOR_X_POSITIONS[action.from as keyof typeof ACTOR_X_POSITIONS];
    const targetX =
      ACTOR_X_POSITIONS[action.to as keyof typeof ACTOR_X_POSITIONS];
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
