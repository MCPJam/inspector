import { useMemo } from "react";
import { ArchDiagramContent } from "@/components/architecture-diagram";
import {
  buildWhatIsMcpScenario,
  WHAT_IS_MCP_STEP_ORDER,
  STEP_HIGHLIGHTS,
} from "./what-is-mcp-data";

interface WhatIsMcpDiagramProps {
  currentStep?: string;
  onStepClick?: (stepId: string) => void;
}

export function WhatIsMcpDiagram({
  currentStep,
  onStepClick,
}: WhatIsMcpDiagramProps) {
  const scenario = useMemo(() => buildWhatIsMcpScenario(), []);

  return (
    <ArchDiagramContent
      nodes={scenario.nodes}
      edges={scenario.edges}
      currentStep={currentStep}
      stepOrder={WHAT_IS_MCP_STEP_ORDER}
      stepHighlights={STEP_HIGHLIGHTS}
      onNodeStepClick={onStepClick}
      onEdgeStepClick={onStepClick}
    />
  );
}
