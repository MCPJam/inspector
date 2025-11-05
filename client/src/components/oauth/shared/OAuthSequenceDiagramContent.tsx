import { useMemo, memo } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { OAuthFlowState } from "@/lib/oauth/state-machines/types";
import { DiagramLayout, buildNodesAndEdges, type Action } from "./index";

interface OAuthSequenceDiagramContentProps {
  flowState: OAuthFlowState;
  actions: Action[];
}

const DiagramContent = memo(
  ({ flowState, actions }: OAuthSequenceDiagramContentProps) => {
    const { nodes, edges } = useMemo(() => {
      return buildNodesAndEdges(actions, flowState.currentStep);
    }, [actions, flowState.currentStep]);

    return (
      <DiagramLayout
        nodes={nodes}
        edges={edges}
        currentStep={flowState.currentStep}
      />
    );
  },
);

DiagramContent.displayName = "OAuthDiagramContent";

export const OAuthSequenceDiagramContent = memo(
  (props: OAuthSequenceDiagramContentProps) => {
    return (
      <ReactFlowProvider>
        <DiagramContent {...props} />
      </ReactFlowProvider>
    );
  },
);

OAuthSequenceDiagramContent.displayName = "OAuthSequenceDiagramContent";
