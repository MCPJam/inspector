import { useMemo } from "react";
import {
  SequenceDiagramContent,
  computeActorXPositions,
} from "@/components/sequence-diagram";
import {
  buildMcpLifecycleScenario20250326,
  type McpTransport,
} from "./mcp-lifecycle-data";

interface McpLifecycleDiagramProps {
  transport: McpTransport;
  /**
   * When provided, enables step-by-step walkthrough mode.
   * Accepts any string — lifecycle step IDs or sentinel values for walkthrough control.
   */
  currentStep?: string;
  focusedStep?: string;
  /** Callback when user clicks an edge label in the diagram */
  onStepClick?: (stepId: string) => void;
}

export function McpLifecycleDiagram({
  transport,
  currentStep,
  focusedStep,
  onStepClick,
}: McpLifecycleDiagramProps) {
  const scenario = useMemo(
    () => buildMcpLifecycleScenario20250326({ transport }),
    [transport],
  );

  const actorXPositions = useMemo(
    () => computeActorXPositions(scenario.actors),
    [scenario.actors],
  );

  return (
    <SequenceDiagramContent
      actors={scenario.actors}
      actions={scenario.actions}
      actorXPositions={actorXPositions}
      currentStep={currentStep}
      focusedStep={focusedStep}
      onStepClick={onStepClick}
    />
  );
}
