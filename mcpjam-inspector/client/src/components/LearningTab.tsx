import { useState, useMemo, useCallback, useRef } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";
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
import {
  HTTP_STEP_ORDER,
  isLastHttpLifecycleStep,
  nextHttpLifecycleStepId,
} from "@/components/lifecycle/mcp-lifecycle-guide-data";
import { LearningLandingPage } from "@/components/LearningLandingPage";
import { WhatIsMcpDiagram } from "@/components/what-is-mcp/WhatIsMcpDiagram";
import { WhatIsMcpGuide } from "@/components/what-is-mcp/WhatIsMcpGuide";
import {
  WHAT_IS_MCP_STEP_ORDER,
} from "@/components/what-is-mcp/what-is-mcp-data";
import {
  isLastWhatIsMcpStep,
  nextWhatIsMcpStepId,
} from "@/components/what-is-mcp/what-is-mcp-guide-data";

/**
 * Sentinel value used as `currentStep` when the walkthrough is at step 0.
 * It won't match any real action ID, which makes action[0] get "current" status
 * (the status logic marks actionIndex === currentIndex + 1 as "current",
 * and findIndex returns -1 for the sentinel → currentIndex = -1 → action[0] is current).
 */
const WALKTHROUGH_START_SENTINEL = "__walkthrough_start__";

function McpLifecycleWalkthrough({ onBack }: { onBack: () => void }) {
  // Active step — which section is currently visible in the scroll container
  const [activeStepId, setActiveStepId] = useState<string | undefined>(
    undefined,
  );
  // Target step to scroll to — set when user clicks a diagram edge
  const [scrollTargetStepId, setScrollTargetStepId] = useState<
    string | undefined
  >(undefined);
  /** Bumps when programmatically scrolling so repeating the same step still runs scrollIntoView. */
  const [scrollToStepToken, setScrollToStepToken] = useState(0);
  // Guard to prevent feedback loops during programmatic scroll
  const isProgrammaticScrollRef = useRef(false);

  const scenario = useMemo(
    () => buildMcpLifecycleScenario20250326({ transport: "http" }),
    [],
  );

  // Derive currentStep for the diagram:
  // - active step gets "current" (blue) status
  // - steps before it get "complete" (green) status
  // - steps after get "pending" (gray) status
  const currentStep = useMemo(() => {
    if (!activeStepId) return undefined;
    const idx = HTTP_STEP_ORDER.indexOf(
      activeStepId as (typeof HTTP_STEP_ORDER)[number],
    );
    if (idx < 0) return undefined;
    if (idx === 0) return WALKTHROUGH_START_SENTINEL;
    return scenario.actions[idx - 1].id;
  }, [activeStepId, scenario.actions]);

  // Scroll → Diagram: IntersectionObserver detected a new section in view
  const handleScrollStepChange = useCallback((stepId: string) => {
    if (isProgrammaticScrollRef.current) return;
    setActiveStepId(stepId);
  }, []);

  const scrollToStep = useCallback((stepId: string) => {
    isProgrammaticScrollRef.current = true;
    setActiveStepId(stepId);
    setScrollTargetStepId(stepId);
    setScrollToStepToken((t) => t + 1);
  }, []);

  // Diagram → Scroll: user clicked an edge label
  const handleDiagramStepClick = useCallback(
    (stepId: string) => {
      scrollToStep(stepId);
    },
    [scrollToStep],
  );

  // Called after programmatic scroll animation completes
  const handleScrollComplete = useCallback(() => {
    isProgrammaticScrollRef.current = false;
    setScrollTargetStepId(undefined);
  }, []);

  const continueLabel = isLastHttpLifecycleStep(activeStepId)
    ? "Start over"
    : "Continue";

  const handleContinue = useCallback(() => {
    const nextId = nextHttpLifecycleStepId(activeStepId);
    scrollToStep(nextId);
  }, [activeStepId, scrollToStep]);

  const handleReset = useCallback(() => {
    scrollToStep(HTTP_STEP_ORDER[0]);
  }, [scrollToStep]);

  return (
    <div className="flex h-full flex-col">
      {/* Minimal header bar */}
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
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
            className="text-[10px] h-4 px-1.5 shrink-0"
          >
            HTTP
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="h-7"
            title="Jump back to the first step"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
          <Button size="sm" onClick={handleContinue} className="h-7">
            {continueLabel}
          </Button>
        </div>
      </div>

      {/* Split view: Content (left) + Diagram (right) */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={50} minSize={30}>
            <McpLifecycleGuide
              activeStepId={activeStepId}
              onActiveStepChange={handleScrollStepChange}
              scrollToStepId={scrollTargetStepId}
              scrollToStepToken={scrollToStepToken}
              onScrollComplete={handleScrollComplete}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50} minSize={20} maxSize={70}>
            <McpLifecycleDiagram
              transport="http"
              currentStep={currentStep}
              focusedStep={activeStepId}
              onStepClick={handleDiagramStepClick}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "What is MCP?" Walkthrough
// ---------------------------------------------------------------------------

function WhatIsMcpWalkthrough({ onBack }: { onBack: () => void }) {
  const [activeStepId, setActiveStepId] = useState<string | undefined>(
    undefined,
  );
  const [scrollTargetStepId, setScrollTargetStepId] = useState<
    string | undefined
  >(undefined);
  const [scrollToStepToken, setScrollToStepToken] = useState(0);
  const isProgrammaticScrollRef = useRef(false);

  // For the architecture diagram, currentStep is simply the activeStepId
  // (no sentinel needed — the highlight map handles step 0 directly)
  const currentStep = activeStepId;

  const handleScrollStepChange = useCallback((stepId: string) => {
    if (isProgrammaticScrollRef.current) return;
    setActiveStepId(stepId);
  }, []);

  const scrollToStep = useCallback((stepId: string) => {
    isProgrammaticScrollRef.current = true;
    setActiveStepId(stepId);
    setScrollTargetStepId(stepId);
    setScrollToStepToken((t) => t + 1);
  }, []);

  const handleDiagramStepClick = useCallback(
    (nodeId: string) => {
      // Map node IDs to their corresponding walkthrough step
      const nodeToStep: Record<string, string> = {
        "host-group": "host_app",
        "llm-app": "host_app",
        "mcp-client": "mcp_client",
        "server-tools": "mcp_servers",
        "server-resources": "mcp_servers",
        "server-prompts": "mcp_servers",
        tools: "tools",
        resources: "resources",
        prompts: "prompts",
      };
      const stepId = nodeToStep[nodeId] ?? nodeId;
      // Only scroll if it's a valid step
      if (
        WHAT_IS_MCP_STEP_ORDER.includes(
          stepId as (typeof WHAT_IS_MCP_STEP_ORDER)[number],
        )
      ) {
        scrollToStep(stepId);
      }
    },
    [scrollToStep],
  );

  const handleScrollComplete = useCallback(() => {
    isProgrammaticScrollRef.current = false;
    setScrollTargetStepId(undefined);
  }, []);

  const continueLabel = isLastWhatIsMcpStep(activeStepId)
    ? "Start over"
    : "Continue";

  const handleContinue = useCallback(() => {
    const nextId = nextWhatIsMcpStepId(activeStepId);
    scrollToStep(nextId);
  }, [activeStepId, scrollToStep]);

  const handleReset = useCallback(() => {
    scrollToStep(WHAT_IS_MCP_STEP_ORDER[0]);
  }, [scrollToStep]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            title="Back to Learning"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <h2 className="text-sm font-semibold">What is MCP?</h2>
          <Badge
            variant="secondary"
            className="text-[10px] h-4 px-1.5 shrink-0"
          >
            Fundamentals
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="h-7"
            title="Jump back to the first step"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
          <Button size="sm" onClick={handleContinue} className="h-7">
            {continueLabel}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={50} minSize={30}>
            <WhatIsMcpGuide
              activeStepId={activeStepId}
              onActiveStepChange={handleScrollStepChange}
              scrollToStepId={scrollTargetStepId}
              scrollToStepToken={scrollToStepToken}
              onScrollComplete={handleScrollComplete}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50} minSize={20} maxSize={70}>
            <WhatIsMcpDiagram
              currentStep={currentStep}
              onStepClick={handleDiagramStepClick}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LearningTab — routes to the selected concept
// ---------------------------------------------------------------------------

export function LearningTab() {
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);

  if (selectedConcept === "what-is-mcp") {
    return <WhatIsMcpWalkthrough onBack={() => setSelectedConcept(null)} />;
  }

  if (selectedConcept === "mcp-lifecycle") {
    return <McpLifecycleWalkthrough onBack={() => setSelectedConcept(null)} />;
  }

  return <LearningLandingPage onSelect={setSelectedConcept} />;
}
