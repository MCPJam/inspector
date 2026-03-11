import { useState, useMemo, useCallback, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { McpLifecycleDiagram } from "@/components/lifecycle/McpLifecycleDiagram";
import { McpLifecycleGuide } from "@/components/lifecycle/McpLifecycleGuide";
import { buildMcpLifecycleScenario20250326 } from "@/components/lifecycle/mcp-lifecycle-data";
import { LearningLandingPage } from "@/components/LearningLandingPage";

/**
 * Sentinel value used as `currentStep` when the walkthrough is at step 0.
 * It won't match any real action ID, which makes action[0] get "current" status
 * (the status logic marks actionIndex === currentIndex + 1 as "current",
 * and findIndex returns -1 for the sentinel → currentIndex = -1 → action[0] is current).
 */
const WALKTHROUGH_START_SENTINEL = "__walkthrough_start__";

function McpLifecycleWalkthrough({ onBack }: { onBack: () => void }) {
  const [stepIndex, setStepIndex] = useState(-1); // -1 = overview (all neutral)
  const [focusedStepId, setFocusedStepId] = useState<string | undefined>(
    undefined,
  );

  const scenario = useMemo(
    () => buildMcpLifecycleScenario20250326({ transport: "http" }),
    [],
  );

  const totalSteps = scenario.actions.length;
  const isOverview = stepIndex === -1;

  const currentStep = useMemo(() => {
    if (stepIndex === -1) return undefined;
    if (stepIndex === 0) return WALKTHROUGH_START_SENTINEL;
    return scenario.actions[stepIndex - 1].id;
  }, [stepIndex, scenario.actions]);

  const focusedAction =
    stepIndex >= 0 && stepIndex < totalSteps
      ? scenario.actions[stepIndex]
      : null;

  // Clear focusedStepId when stepIndex changes
  useEffect(() => {
    setFocusedStepId(undefined);
  }, [stepIndex]);

  const handleNext = useCallback(() => {
    setStepIndex((prev) => Math.min(prev + 1, totalSteps - 1));
  }, [totalSteps]);

  const handlePrev = useCallback(() => {
    setStepIndex((prev) => Math.max(prev - 1, -1));
  }, []);

  const handleReset = useCallback(() => {
    setStepIndex(-1);
  }, []);

  const handleGoToStep = useCallback((index: number) => {
    setStepIndex(index);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Minimal header bar */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            title="Back to Learning"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <h2 className="text-sm font-semibold">MCP Protocol Lifecycle</h2>
          <Badge
            variant="secondary"
            className="text-[10px] h-4 px-1.5"
          >
            HTTP
          </Badge>
        </div>
      </div>

      {/* Split view: Diagram + Guide */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={50} minSize={30}>
            <McpLifecycleDiagram
              transport="http"
              currentStep={currentStep}
              focusedStep={focusedStepId ?? focusedAction?.id}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50} minSize={20} maxSize={70}>
            <McpLifecycleGuide
              stepIndex={stepIndex}
              totalSteps={totalSteps}
              onGoToStep={handleGoToStep}
              onFocusStep={setFocusedStepId}
              onNext={handleNext}
              onPrev={handlePrev}
              onReset={handleReset}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

export function LearningTab() {
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);

  if (selectedConcept === "mcp-lifecycle") {
    return (
      <McpLifecycleWalkthrough onBack={() => setSelectedConcept(null)} />
    );
  }

  return <LearningLandingPage onSelect={setSelectedConcept} />;
}
