import { useMemo, memo } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { DiagramLayout } from "./DiagramLayout";
import { buildNodesAndEdges } from "./diagramBuilder";
import type {
  SequenceDiagramActorConfig,
  SequenceDiagramAction,
  DiagramZoomConfig,
} from "./types";

interface SequenceDiagramContentProps {
  actors: SequenceDiagramActorConfig[];
  actions: SequenceDiagramAction[];
  actorXPositions: Record<string, number>;
  /** When undefined, all edges get "neutral" status (static educational view) */
  currentStep?: string;
  focusedStep?: string;
  zoomConfig?: DiagramZoomConfig;
}

const DiagramContent = memo(
  ({
    actors,
    actions,
    actorXPositions,
    currentStep,
    focusedStep,
    zoomConfig,
  }: SequenceDiagramContentProps) => {
    const { nodes, edges } = useMemo(
      () =>
        buildNodesAndEdges({
          actors,
          actions,
          currentStep,
          actorXPositions,
        }),
      [actors, actions, currentStep, actorXPositions],
    );

    return (
      <DiagramLayout
        nodes={nodes}
        edges={edges}
        currentStep={currentStep}
        focusedStep={focusedStep}
        zoomConfig={zoomConfig}
      />
    );
  },
);

DiagramContent.displayName = "SequenceDiagramContent";

export const SequenceDiagramContent = memo(
  (props: SequenceDiagramContentProps) => {
    return (
      <ReactFlowProvider>
        <DiagramContent {...props} />
      </ReactFlowProvider>
    );
  },
);

SequenceDiagramContent.displayName = "SequenceDiagramContentWrapper";
