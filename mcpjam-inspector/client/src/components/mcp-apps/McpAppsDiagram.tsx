import { useMemo } from "react";
import { ArchDiagramContent } from "@/components/architecture-diagram";
import {
  buildMcpAppsScenario,
  MCP_APPS_STEP_ORDER,
  MCP_APPS_STEP_HIGHLIGHTS,
} from "./mcp-apps-data";

interface McpAppsDiagramProps {
  currentStep?: string;
  onStepClick?: (stepId: string) => void;
}

export function McpAppsDiagram({
  currentStep,
  onStepClick,
}: McpAppsDiagramProps) {
  const scenario = useMemo(() => buildMcpAppsScenario(), []);

  return (
    <ArchDiagramContent
      nodes={scenario.nodes}
      edges={scenario.edges}
      currentStep={currentStep}
      stepOrder={MCP_APPS_STEP_ORDER}
      stepHighlights={MCP_APPS_STEP_HIGHLIGHTS}
      onNodeStepClick={onStepClick}
      onEdgeStepClick={onStepClick}
    />
  );
}
