import { useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { useScrollSpy } from "@/hooks/use-scroll-spy";
import { APPS_SDK_STEP_ORDER, type AppsSdkStep } from "./apps-sdk-data";
import {
  APPS_SDK_GUIDE_METADATA,
  type AppsSdkStepGuide,
} from "./apps-sdk-guide-data";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AppsSdkGuideProps {
  activeStepId: string | undefined;
  onActiveStepChange: (stepId: string) => void;
  scrollToStepId: string | undefined;
  scrollToStepToken?: number;
  onScrollComplete: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepSection({
  stepId,
  index,
  isActive,
  registerRef,
}: {
  stepId: AppsSdkStep;
  index: number;
  isActive: boolean;
  registerRef: (id: string, el: HTMLElement | null) => void;
}) {
  const guide = APPS_SDK_GUIDE_METADATA[stepId] as AppsSdkStepGuide | undefined;
  if (!guide) return null;

  return (
    <motion.section
      id={`section-${stepId}`}
      ref={(el) => registerRef(stepId, el)}
      data-step-id={stepId}
      className="relative scroll-mt-8 py-12 first:pt-6"
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5 }}
    >
      <motion.div
        className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full"
        animate={{
          backgroundColor: isActive
            ? "hsl(var(--foreground) / 0.15)"
            : "transparent",
          scaleY: isActive ? 1 : 0.3,
          opacity: isActive ? 1 : 0,
        }}
        transition={{ duration: 0.35 }}
      />

      <div className="pl-5 space-y-5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground font-mono">
            Step {index + 1}
          </span>
        </div>

        <h2 className="text-xl font-semibold tracking-tight text-foreground -mt-1">
          {guide.title}
        </h2>

        <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">
          {guide.summary}
        </p>

        {guide.analogy && (
          <aside className="border-l-2 border-border pl-4">
            <p className="text-[13px] text-foreground/80 leading-relaxed italic">
              {guide.analogy}
            </p>
          </aside>
        )}

        {guide.teachableMoments.length > 0 && (
          <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
            {guide.teachableMoments.map((moment, i) => (
              <li key={i}>{moment}</li>
            ))}
          </ul>
        )}

        {guide.examples && guide.examples.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <ul className="space-y-1.5">
              {guide.examples.map((example, i) => (
                <li
                  key={i}
                  className="text-[12px] font-mono text-foreground/70 leading-relaxed"
                >
                  {example}
                </li>
              ))}
            </ul>
          </div>
        )}

        {guide.tips.length > 0 && (
          <aside className="border-l-2 border-border pl-4">
            <ul className="space-y-1 text-[13px] text-foreground/80 leading-relaxed">
              {guide.tips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      <div className="mt-12 border-b border-border/30" />
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AppsSdkGuide({
  activeStepId,
  onActiveStepChange,
  scrollToStepId,
  scrollToStepToken = 0,
  onScrollComplete,
}: AppsSdkGuideProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScroll = useRef(false);

  const handleActiveChange = useCallback(
    (id: string) => {
      if (isProgrammaticScroll.current) return;
      onActiveStepChange(id);
    },
    [onActiveStepChange],
  );

  const { registerSection } = useScrollSpy(
    APPS_SDK_STEP_ORDER,
    scrollContainerRef,
    handleActiveChange,
    true,
  );

  useEffect(() => {
    if (!scrollToStepId) return;
    const el = document.getElementById(`section-${scrollToStepId}`);
    if (el) {
      isProgrammaticScroll.current = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      const timer = setTimeout(() => {
        isProgrammaticScroll.current = false;
        onScrollComplete();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [scrollToStepId, scrollToStepToken, onScrollComplete]);

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto scrollbar-thin"
    >
      <div className="px-8 pt-8 pb-4">
        <div className="space-y-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            OpenAI Apps SDK
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">
            See how the Apps SDK adds ChatGPT-only features on top of standard
            MCP Apps:{" "}
            <span className="font-medium text-foreground/80">
              window.openai
            </span>
            , extra tool metadata, and dual-protocol support. Scroll to sync
            the diagram, or use{" "}
            <span className="font-medium text-foreground/80">Continue</span> in
            the header to advance.
          </p>
        </div>
      </div>

      <div className="px-8 pb-16">
        {APPS_SDK_STEP_ORDER.map((stepId, index) => (
          <StepSection
            key={stepId}
            stepId={stepId}
            index={index}
            isActive={activeStepId === stepId}
            registerRef={registerSection}
          />
        ))}

        <div className="pt-8 pb-4 text-center">
          <p className="text-sm text-muted-foreground/60">
            Use{" "}
            <span className="font-medium text-foreground/70">Start over</span>{" "}
            or tap nodes and edges in the diagram to jump back to a section.
          </p>
        </div>
      </div>
    </div>
  );
}
