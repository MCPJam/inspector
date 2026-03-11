import { useState, useMemo, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Monitor,
  Play,
  RotateCcw,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { McpLifecycleDiagram } from "@/components/lifecycle/McpLifecycleDiagram";
import {
  buildMcpLifecycleScenario20250326,
  type McpTransport,
} from "@/components/lifecycle/mcp-lifecycle-data";

/**
 * Sentinel value used as `currentStep` when the walkthrough is at step 0.
 * It won't match any real action ID, which makes action[0] get "current" status
 * (the status logic marks actionIndex === currentIndex + 1 as "current",
 * and findIndex returns -1 for the sentinel → currentIndex = -1 → action[0] is current).
 */
const WALKTHROUGH_START_SENTINEL = "__walkthrough_start__";

export function LearningTab() {
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [stepIndex, setStepIndex] = useState(-1); // -1 = overview (all neutral)

  const scenario = useMemo(
    () => buildMcpLifecycleScenario20250326({ transport }),
    [transport],
  );

  const totalSteps = scenario.actions.length;
  const isOverview = stepIndex === -1;
  const isLastStep = stepIndex === totalSteps - 1;

  /**
   * Map stepIndex to `currentStep` for the diagram renderer:
   *
   * - stepIndex = -1 → undefined → all edges get "neutral" status (static overview)
   * - stepIndex = 0  → sentinel  → action[0] is "current" (blue pulsing)
   * - stepIndex = K  → actions[K-1].id → actions[0..K-1] are "complete", action[K] is "current"
   */
  const currentStep = useMemo(() => {
    if (stepIndex === -1) return undefined;
    if (stepIndex === 0) return WALKTHROUGH_START_SENTINEL;
    return scenario.actions[stepIndex - 1].id;
  }, [stepIndex, scenario.actions]);

  /** The action being focused / learned about at the current walkthrough step */
  const focusedAction =
    stepIndex >= 0 && stepIndex < totalSteps
      ? scenario.actions[stepIndex]
      : null;

  const handleNext = useCallback(() => {
    setStepIndex((prev) => Math.min(prev + 1, totalSteps - 1));
  }, [totalSteps]);

  const handlePrev = useCallback(() => {
    setStepIndex((prev) => Math.max(prev - 1, -1));
  }, []);

  const handleReset = useCallback(() => {
    setStepIndex(-1);
  }, []);

  const handleTransportChange = useCallback((val: string) => {
    if (val) {
      setTransport(val as McpTransport);
      setStepIndex(-1); // reset walkthrough on transport change
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">MCP Protocol Lifecycle</h2>
        <div className="flex items-center gap-3">
          {/* Step navigation controls */}
          <div className="flex items-center gap-1.5">
            {isOverview ? (
              <Button variant="outline" size="sm" onClick={handleNext}>
                <Play className="mr-1 h-3.5 w-3.5" />
                Start Walkthrough
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrev}
                  disabled={isOverview}
                  title="Previous step"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="min-w-[5.5rem] text-center text-xs text-muted-foreground tabular-nums">
                  Step {stepIndex + 1} of {totalSteps}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNext}
                  disabled={isLastStep}
                  title="Next step"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleReset}
                  title="Back to overview"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>

          {/* Transport toggle */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={transport}
            onValueChange={handleTransportChange}
          >
            <ToggleGroupItem value="stdio">
              <Terminal className="mr-1.5 h-3.5 w-3.5" />
              stdio
            </ToggleGroupItem>
            <ToggleGroupItem value="http">
              <Monitor className="mr-1.5 h-3.5 w-3.5" />
              HTTP
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* Step description bar — visible only during walkthrough */}
      {focusedAction && (
        <div className="border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-medium text-blue-600 dark:text-blue-400">
              {focusedAction.label}
            </span>
            <span className="text-xs text-muted-foreground">—</span>
            <span className="text-xs text-muted-foreground">
              {focusedAction.description}
            </span>
          </div>
        </div>
      )}

      {/* Diagram fills remaining space */}
      <div className="flex-1 min-h-0">
        <McpLifecycleDiagram
          transport={transport}
          currentStep={currentStep}
          focusedStep={focusedAction?.id}
        />
      </div>
    </div>
  );
}
