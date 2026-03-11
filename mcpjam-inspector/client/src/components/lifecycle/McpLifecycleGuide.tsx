import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ArrowRight, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  HTTP_STEP_ORDER,
  LIFECYCLE_GUIDE_SLIM,
  PHASE_ACCENT,
  type McpLifecycleStepSlim,
} from "./mcp-lifecycle-guide-data";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpLifecycleGuideProps {
  stepIndex: number; // -1 = overview, 0+ = step
  totalSteps: number;
  onGoToStep: (index: number) => void;
  onFocusStep: (stepId: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onReset: () => void;
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

const EASE = [0.25, 0.1, 0.25, 1] as const;

/** Per-child stagger — explicit delays are more reliable than variant propagation */
const STAGGER_BASE = 0.12; // initial delay (wait for parent slide-in)
const STAGGER_GAP = 0.07; // gap between each child

function fadeUp(order: number) {
  const delay = STAGGER_BASE + order * STAGGER_GAP;
  return {
    initial: { opacity: 0, y: 14 } as const,
    animate: { opacity: 1, y: 0 } as const,
    transition: { delay, duration: 0.38, ease: EASE },
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProgressDots({
  total,
  current,
  onSelect,
}: {
  total: number;
  current: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2.5">
      {Array.from({ length: total }).map((_, i) => {
        const step = LIFECYCLE_GUIDE_SLIM[HTTP_STEP_ORDER[i]];
        const isActive = i === current;
        const isVisited = current >= 0 && i <= current;
        const color = step ? PHASE_ACCENT[step.phase] : "#94a3b8";

        return (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className="relative flex items-center justify-center p-1 -m-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
            aria-label={`Go to step ${i + 1}`}
          >
            <motion.div
              className="rounded-full"
              animate={{
                scale: isActive ? 1.5 : 1,
                backgroundColor: isVisited ? color : "var(--border)",
              }}
              transition={
                isActive
                  ? { type: "spring", stiffness: 300, damping: 20 }
                  : { duration: 0.3, ease: EASE }
              }
              style={{ width: 7, height: 7 }}
            />
          </button>
        );
      })}
    </div>
  );
}

function DirectionIndicator({
  direction,
  order,
}: {
  direction: McpLifecycleStepSlim["direction"];
  order: number;
}) {
  const isToServer = direction === "client-to-server";
  return (
    <motion.div
      className="flex items-center gap-2 text-muted-foreground/60"
      {...fadeUp(order)}
    >
      <span className="text-[11px] font-medium">
        {isToServer ? "Client" : "Server"}
      </span>
      <ArrowRight className="h-3 w-3" />
      <span className="text-[11px] font-medium">
        {isToServer ? "Server" : "Client"}
      </span>
    </motion.div>
  );
}

function OverviewView({ onStart }: { onStart: () => void }) {
  return (
    <motion.div
      key="overview"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex flex-col items-center justify-center h-full px-8 text-center"
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
        className="space-y-4 max-w-xs"
      >
        <h3 className="text-lg font-semibold tracking-tight text-foreground">
          MCP Lifecycle
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Walk through the five steps of an HTTP MCP connection — from the
          initial handshake to normal operations.
        </p>
        <Button onClick={onStart} className="mt-2">
          Begin
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </motion.div>
    </motion.div>
  );
}

function StepView({
  step,
}: {
  step: McpLifecycleStepSlim;
  index: number;
}) {
  const phaseColor = PHASE_ACCENT[step.phase];

  return (
    <div className="flex flex-col items-center justify-center h-full px-8">
      <div className="w-full max-w-sm space-y-6">
        {/* Phase label */}
        <motion.div className="flex items-center gap-2" {...fadeUp(0)}>
          <span
            className="block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: phaseColor }}
          />
          <span
            className="text-[11px] font-medium uppercase tracking-wider"
            style={{ color: phaseColor }}
          >
            {step.phase}
          </span>
        </motion.div>

        {/* Title */}
        <motion.h3
          className="text-xl font-semibold tracking-tight text-foreground -mt-2"
          {...fadeUp(1)}
        >
          {step.title}
        </motion.h3>

        {/* Subtitle */}
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed -mt-3"
          {...fadeUp(2)}
        >
          {step.subtitle}
        </motion.p>

        {/* Direction */}
        <DirectionIndicator direction={step.direction} order={3} />

        {/* Key insight */}
        <motion.blockquote
          className="border-l-2 pl-4 text-[13px] text-foreground/75 leading-relaxed italic"
          style={{ borderColor: phaseColor }}
          {...fadeUp(4)}
        >
          {step.keyInsight}
        </motion.blockquote>

        {/* Code snippet */}
        {step.codeSnippet && (
          <motion.div {...fadeUp(5)}>
            <pre
              className="rounded-lg border border-border bg-muted/30 p-4 text-[11px] leading-relaxed font-mono text-foreground/70 overflow-x-auto"
              style={{ borderLeftWidth: 2, borderLeftColor: phaseColor }}
            >
              {step.codeSnippet}
            </pre>
          </motion.div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function McpLifecycleGuide({
  stepIndex,
  totalSteps,
  onGoToStep,
  onNext,
  onPrev,
  onReset,
}: McpLifecycleGuideProps) {
  const prevIndexRef = useRef(stepIndex);
  const direction = stepIndex >= prevIndexRef.current ? 1 : -1;
  // Update ref *after* computing direction
  prevIndexRef.current = stepIndex;

  const isOverview = stepIndex === -1;
  const isLastStep = stepIndex === totalSteps - 1;

  const currentStepId =
    stepIndex >= 0 ? HTTP_STEP_ORDER[stepIndex] : undefined;
  const currentStep = currentStepId
    ? LIFECYCLE_GUIDE_SLIM[currentStepId]
    : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-3">
        <span className="text-xs font-medium text-muted-foreground">
          {isOverview ? "Overview" : `Step ${stepIndex + 1} of ${totalSteps}`}
        </span>
        {!isOverview && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7 px-2 text-xs text-muted-foreground"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        )}
      </div>

      {/* Progress dots */}
      {!isOverview && (
        <div className="py-4">
          <ProgressDots
            total={totalSteps}
            current={stepIndex}
            onSelect={onGoToStep}
          />
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          {isOverview ? (
            <OverviewView key="overview" onStart={onNext} />
          ) : currentStep ? (
            <motion.div
              key={currentStepId}
              custom={direction}
              initial={{ opacity: 0, x: direction * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -40 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="h-full"
            >
              <StepView step={currentStep} index={stepIndex} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* Footer navigation */}
      {!isOverview && (
        <div className="flex items-center justify-between border-t px-6 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPrev}
            className="text-xs"
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            Back
          </Button>

          <span className="text-[11px] text-muted-foreground tabular-nums">
            {stepIndex + 1} / {totalSteps}
          </span>

          {!isLastStep ? (
            <Button size="sm" onClick={onNext} className="text-xs">
              Continue
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onReset}
              className="text-xs"
            >
              Start Over
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
