import { useEffect } from "react";
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
import type { OAuthFlowStep } from "@/lib/oauth/state-machines/types";

const nodeTypes = {
  actor: ActorNode,
};

const edgeTypes = {
  actionEdge: CustomActionEdge,
};

interface DiagramLayoutProps {
  nodes: Node[];
  edges: Edge[];
  currentStep: OAuthFlowStep;
}

export const DiagramLayout = ({
  nodes,
  edges,
  currentStep,
}: DiagramLayoutProps) => {
  const reactFlowInstance = useReactFlow();

  // Auto-zoom to current step
  useEffect(() => {
    if (!reactFlowInstance || !currentStep) {
      return;
    }

    // Small delay to ensure nodes are rendered
    const timer = setTimeout(() => {
      // If reset to idle, zoom back to the top
      if (currentStep === "idle") {
        // Zoom to the top of the diagram
        // Center around the middle actors (Client and MCP Server)
        reactFlowInstance.setCenter(550, 200, {
          zoom: 0.8,
          duration: 800,
        });
        return;
      }

      // Don't zoom when flow is complete - let user stay at current position
      if (currentStep === "complete") {
        return;
      }

      // Find the edge that has "current" status (the next step to execute)
      const currentEdge = edges.find((e) => e.data?.status === "current");

      if (currentEdge) {
        // Get source and target actor positions
        const sourceNode = nodes.find((n) => n.id === currentEdge.source);
        const targetNode = nodes.find((n) => n.id === currentEdge.target);

        if (sourceNode && targetNode) {
          // Find the action index to calculate Y position
          const actionIndex = edges.findIndex((e) => e.id === currentEdge.id);

          // Calculate positions
          // Actor nodes have a header (~52px) + some padding (~50px)
          // Each action segment is ACTION_SPACING (180) apart
          const headerOffset = 102;
          const actionY = headerOffset + actionIndex * 180 + 40; // 40 is half of SEGMENT_HEIGHT
          const centerX =
            (sourceNode.position.x + targetNode.position.x) / 2 + 70; // +70 to account for node width
          const centerY = actionY;

          // Zoom into the current step with animation
          reactFlowInstance.setCenter(centerX, centerY, {
            zoom: 1.2,
            duration: 800,
          });
        }
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [currentStep, edges, nodes, reactFlowInstance]);

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
        panOnScroll={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        panOnDrag={true}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
};
