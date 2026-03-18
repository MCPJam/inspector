import { useEffect, useCallback } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ActorNode } from "./ActorNode";
import { CustomActionEdge } from "./CustomActionEdge";
import type { DiagramZoomConfig } from "./types";

const nodeTypes = {
  actor: ActorNode,
};

const edgeTypes = {
  actionEdge: CustomActionEdge,
};

interface DiagramLayoutProps {
  nodes: Node[];
  edges: Edge[];
  /** When undefined, no auto-zoom occurs (static view, user controls viewport) */
  currentStep?: string;
  focusedStep?: string | null;
  zoomConfig?: DiagramZoomConfig;
  /** Callback when user clicks an edge label in the diagram */
  onStepClick?: (stepId: string) => void;
}

export const DiagramLayout = ({
  nodes,
  edges,
  currentStep,
  focusedStep,
  zoomConfig,
  onStepClick,
}: DiagramLayoutProps) => {
  const reactFlowInstance = useReactFlow();

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const stepId = edge.data?.stepId as string | undefined;
      if (stepId && onStepClick) {
        onStepClick(stepId);
      }
    },
    [onStepClick],
  );

  // Auto-zoom to current step — skipped entirely when currentStep is undefined
  useEffect(() => {
    if (!reactFlowInstance || currentStep === undefined) {
      return;
    }

    const timer = setTimeout(() => {
      // If at idle step, zoom to the top of the diagram
      if (zoomConfig?.idleStepId && currentStep === zoomConfig.idleStepId) {
        // Compute center from actor node positions midpoint
        const actorNodes = nodes.filter((n) => n.type === "actor");
        if (actorNodes.length > 0) {
          const xs = actorNodes.map((n) => n.position.x);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const centerX = (minX + maxX) / 2 + 70; // +70 for node width
          reactFlowInstance.setCenter(centerX, 200, {
            zoom: 0.8,
            duration: 800,
          });
        }
        return;
      }

      // At complete step, don't auto-zoom — let user stay at current position
      if (
        zoomConfig?.completeStepId &&
        currentStep === zoomConfig.completeStepId
      ) {
        return;
      }

      // Determine which edge to zoom to
      let edgeToZoom;

      if (focusedStep) {
        edgeToZoom = edges.find((e) => e.data?.stepId === focusedStep);
      } else {
        edgeToZoom = edges.find((e) => e.data?.status === "current");
      }

      // Fallback: if no current edge found and no focused step, try to find by currentStep
      if (!edgeToZoom && !focusedStep) {
        edgeToZoom = edges.find((e) => e.data?.stepId === currentStep);
      }

      if (edgeToZoom) {
        const sourceNode = nodes.find((n) => n.id === edgeToZoom.source);
        const targetNode = nodes.find((n) => n.id === edgeToZoom.target);

        if (sourceNode && targetNode) {
          const actionIndex = edges.findIndex((e) => e.id === edgeToZoom.id);
          const headerOffset = 102;
          const actionY = headerOffset + actionIndex * 180 + 40;
          const centerX =
            (sourceNode.position.x + targetNode.position.x) / 2 + 70;
          const centerY = actionY;

          reactFlowInstance.setCenter(centerX, centerY, {
            zoom: 1.2,
            duration: 800,
          });
        }
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [currentStep, focusedStep, edges, nodes, reactFlowInstance, zoomConfig]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.4}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onEdgeClick={handleEdgeClick}
        panOnScroll={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        panOnDrag={true}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
