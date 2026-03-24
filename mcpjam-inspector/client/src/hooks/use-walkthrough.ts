import { useState, useCallback, useRef, useMemo } from "react";

export interface UseWalkthroughOptions {
  stepOrder: readonly string[];
  isLastStep: (current: string | undefined) => boolean;
  nextStepId: (current: string | undefined) => string;
  /** Transform activeStepId into the diagram's currentStep (e.g. sentinel logic) */
  mapToDiagramStep?: (activeStepId: string | undefined) => string | undefined;
}

export interface UseWalkthroughReturn {
  activeStepId: string | undefined;
  /** The step ID passed to the diagram (may differ from activeStepId) */
  currentStep: string | undefined;
  scrollTargetStepId: string | undefined;
  scrollToStepToken: number;
  handleScrollStepChange: (stepId: string) => void;
  scrollToStep: (stepId: string) => void;
  handleScrollComplete: () => void;
  continueLabel: string;
  handleContinue: () => void;
  handleReset: () => void;
}

export function useWalkthrough({
  stepOrder,
  isLastStep,
  nextStepId,
  mapToDiagramStep,
}: UseWalkthroughOptions): UseWalkthroughReturn {
  const [activeStepId, setActiveStepId] = useState<string | undefined>(
    undefined,
  );
  const [scrollTargetStepId, setScrollTargetStepId] = useState<
    string | undefined
  >(undefined);
  const [scrollToStepToken, setScrollToStepToken] = useState(0);
  const isProgrammaticScrollRef = useRef(false);

  const currentStep = useMemo(
    () =>
      mapToDiagramStep ? mapToDiagramStep(activeStepId) : activeStepId,
    [activeStepId, mapToDiagramStep],
  );

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

  const handleScrollComplete = useCallback(() => {
    isProgrammaticScrollRef.current = false;
    setScrollTargetStepId(undefined);
  }, []);

  const continueLabel = isLastStep(activeStepId) ? "Start over" : "Continue";

  const handleContinue = useCallback(() => {
    const next = nextStepId(activeStepId);
    isProgrammaticScrollRef.current = true;
    setActiveStepId(next);
    setScrollTargetStepId(next);
    setScrollToStepToken((t) => t + 1);
  }, [activeStepId, nextStepId]);

  const handleReset = useCallback(() => {
    const first = stepOrder[0];
    isProgrammaticScrollRef.current = true;
    setActiveStepId(first);
    setScrollTargetStepId(first);
    setScrollToStepToken((t) => t + 1);
  }, [stepOrder]);

  return {
    activeStepId,
    currentStep,
    scrollTargetStepId,
    scrollToStepToken,
    handleScrollStepChange,
    scrollToStep,
    handleScrollComplete,
    continueLabel,
    handleContinue,
    handleReset,
  };
}
