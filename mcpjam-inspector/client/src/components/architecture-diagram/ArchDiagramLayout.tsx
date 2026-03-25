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
import { ArchBlockNode } from "./ArchBlockNode";
import { ArchGroupNode } from "./ArchGroupNode";
import { ArchAssetNode } from "./ArchAssetNode";
import { ArchConnectionEdge } from "./ArchConnectionEdge";
import type { StepHighlightMap } from "./types";

const nodeTypes = {
  archBlock: ArchBlockNode,
  archGroup: ArchGroupNode,
  archAsset: ArchAssetNode,
};

const edgeTypes = {
  archConnection: ArchConnectionEdge,
};

interface ArchDiagramLayoutProps {
  nodes: Node[];
  edges: Edge[];
  /** When undefined, no auto-zoom occurs (static view) */
  currentStep?: string;
  /** Step highlights for computing zoom targets */
  stepHighlights?: Record<string, StepHighlightMap>;
  /** Callback when user clicks a node in the diagram */
  onNodeStepClick?: (stepId: string) => void;
  /** Callback when user clicks an edge in the diagram */
  onEdgeStepClick?: (stepId: string) => void;
}

export const ArchDiagramLayout = ({
  nodes,
  edges,
  currentStep,
  stepHighlights,
  onNodeStepClick,
  onEdgeStepClick,
}: ArchDiagramLayoutProps) => {
  const reactFlowInstance = useReactFlow();

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.id && onNodeStepClick) {
        onNodeStepClick(node.id);
      }
    },
    [onNodeStepClick],
  );

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const stepId = edge.data?.stepId as string | undefined;
      if (stepId && onEdgeStepClick) {
        onEdgeStepClick(stepId);
      }
    },
    [onEdgeStepClick],
  );

  // Auto-zoom to current step's active nodes
  useEffect(() => {
    if (!reactFlowInstance || currentStep === undefined) return;

    const timer = setTimeout(() => {
      const highlight = stepHighlights?.[currentStep];
      if (!highlight || highlight.activeNodes.length === 0) {
        // No specific nodes — fit entire diagram
        reactFlowInstance.fitView({ padding: 0.3, duration: 800 });
        return;
      }

      reactFlowInstance.fitView({
        nodes: highlight.activeNodes.map((id) => ({ id })),
        padding: 0.4,
        duration: 800,
      });
    }, 100);

    return () => clearTimeout(timer);
  }, [currentStep, reactFlowInstance, stepHighlights]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.3}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 0.7 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        panOnScroll={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        panOnDrag={true}
        fitView
        fitViewOptions={{ padding: 0.3 }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
