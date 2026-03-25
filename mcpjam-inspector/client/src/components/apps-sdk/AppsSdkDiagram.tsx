import { useMemo } from "react";
import { ArchDiagramContent } from "@/components/architecture-diagram";
import {
  buildAppsSdkScenario,
  APPS_SDK_STEP_ORDER,
  APPS_SDK_STEP_HIGHLIGHTS,
} from "./apps-sdk-data";

interface AppsSdkDiagramProps {
  currentStep?: string;
  onStepClick?: (stepId: string) => void;
}

export function AppsSdkDiagram({
  currentStep,
  onStepClick,
}: AppsSdkDiagramProps) {
  const scenario = useMemo(() => buildAppsSdkScenario(), []);

  return (
    <ArchDiagramContent
      nodes={scenario.nodes}
      edges={scenario.edges}
      currentStep={currentStep}
      stepOrder={APPS_SDK_STEP_ORDER}
      stepHighlights={APPS_SDK_STEP_HIGHLIGHTS}
      onNodeStepClick={onStepClick}
      onEdgeStepClick={onStepClick}
    />
  );
}
