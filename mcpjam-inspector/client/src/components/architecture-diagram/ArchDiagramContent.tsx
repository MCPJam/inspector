import { useMemo, memo } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { ArchDiagramLayout } from "./ArchDiagramLayout";
import {
  buildArchNodesAndEdges,
  type LayoutOptions,
} from "./archDiagramBuilder";
import type { ArchNodeDef, ArchEdgeDef, StepHighlightMap } from "./types";

interface ArchDiagramContentProps {
  nodes: ArchNodeDef[];
  edges: ArchEdgeDef[];
  /** When undefined, all elements get "neutral" status (static view) */
  currentStep?: string;
  stepOrder?: string[];
  stepHighlights?: Record<string, StepHighlightMap>;
  onNodeStepClick?: (stepId: string) => void;
  onEdgeStepClick?: (stepId: string) => void;
  layoutOptions?: LayoutOptions;
}

const DiagramContent = memo(
  ({
    nodes: nodeDefs,
    edges: edgeDefs,
    currentStep,
    stepOrder,
    stepHighlights,
    onNodeStepClick,
    onEdgeStepClick,
    layoutOptions,
  }: ArchDiagramContentProps) => {
    const { nodes, edges } = useMemo(
      () =>
        buildArchNodesAndEdges({
          nodes: nodeDefs,
          edges: edgeDefs,
          currentStep,
          stepOrder,
          stepHighlights,
          layoutOptions,
        }),
      [
        nodeDefs,
        edgeDefs,
        currentStep,
        stepOrder,
        stepHighlights,
        layoutOptions,
      ],
    );

    return (
      <ArchDiagramLayout
        nodes={nodes}
        edges={edges}
        currentStep={currentStep}
        stepHighlights={stepHighlights}
        onNodeStepClick={onNodeStepClick}
        onEdgeStepClick={onEdgeStepClick}
      />
    );
  },
);

DiagramContent.displayName = "ArchDiagramContent";

export const ArchDiagramContent = memo((props: ArchDiagramContentProps) => {
  return (
    <ReactFlowProvider>
      <DiagramContent {...props} />
    </ReactFlowProvider>
  );
});

ArchDiagramContent.displayName = "ArchDiagramContentWrapper";
