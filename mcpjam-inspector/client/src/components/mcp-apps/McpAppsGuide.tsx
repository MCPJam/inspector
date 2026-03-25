import { useRef, useEffect, useCallback } from "react";
import { Lightbulb, Info, Zap } from "lucide-react";
import { motion } from "framer-motion";
import { useScrollSpy } from "@/hooks/use-scroll-spy";
import { MCP_APPS_STEP_ORDER, type McpAppsStep } from "./mcp-apps-data";
import {
  MCP_APPS_GUIDE_METADATA,
  type McpAppsStepGuide,
} from "./mcp-apps-guide-data";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpAppsGuideProps {
  activeStepId: string | undefined;
  onActiveStepChange: (stepId: string) => void;
  scrollToStepId: string | undefined;
  scrollToStepToken?: number;
  onScrollComplete: () => void;
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

const EASE = [0.25, 0.1, 0.25, 1] as const;

function sectionChild(order: number) {
  return {
    initial: { opacity: 0, y: 16 } as const,
    whileInView: { opacity: 1, y: 0 } as const,
    viewport: { once: true } as const,
    transition: {
      delay: order * 0.08,
      duration: 0.4,
      ease: EASE,
    },
  };
}

// ---------------------------------------------------------------------------
// Category accents
// ---------------------------------------------------------------------------

const CATEGORY_ACCENT = {
  overview: "#6366f1", // indigo
  architecture: "#3b82f6", // blue
  protocol: "#10b981", // green
  security: "#f59e0b", // amber
} as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepSection({
  stepId,
  index,
  isActive,
  registerRef,
}: {
  stepId: McpAppsStep;
  index: number;
  isActive: boolean;
  registerRef: (id: string, el: HTMLElement | null) => void;
}) {
  const guide = MCP_APPS_GUIDE_METADATA[stepId] as McpAppsStepGuide | undefined;
  if (!guide) return null;

  const categoryColor =
    CATEGORY_ACCENT[guide.category as keyof typeof CATEGORY_ACCENT] ??
    "#94a3b8";

  return (
    <motion.section
      id={`section-${stepId}`}
      ref={(el) => registerRef(stepId, el)}
      data-step-id={stepId}
      className="relative scroll-mt-8 py-12 first:pt-6"
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <motion.div
        className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full"
        animate={{
          backgroundColor: isActive ? categoryColor : "transparent",
          scaleY: isActive ? 1 : 0.3,
          opacity: isActive ? 1 : 0,
        }}
        transition={{ duration: 0.35 }}
      />

      <div className="pl-5 space-y-5">
        <motion.div className="flex items-center gap-2" {...sectionChild(0)}>
          <span
            className="block h-2 w-2 rounded-full"
            style={{ backgroundColor: categoryColor }}
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: categoryColor }}
          >
            {guide.category}
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            Step {index + 1}
          </span>
        </motion.div>

        <motion.h2
          className="text-xl font-semibold tracking-tight text-foreground -mt-1"
          {...sectionChild(1)}
        >
          {guide.title}
        </motion.h2>

        <motion.p
          className="text-sm text-muted-foreground leading-relaxed max-w-prose"
          {...sectionChild(2)}
        >
          {guide.summary}
        </motion.p>

        {guide.analogy && (
          <motion.div
            className="rounded-lg border border-indigo-200/50 dark:border-indigo-800/30 bg-indigo-50/40 dark:bg-indigo-950/10 p-4"
            {...sectionChild(3)}
          >
            <div className="flex items-center gap-2 mb-2">
              <Zap className="h-3.5 w-3.5 text-indigo-500/70" />
              <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                Analogy
              </span>
            </div>
            <p className="text-[13px] text-foreground/80 leading-relaxed">
              {guide.analogy}
            </p>
          </motion.div>
        )}

        {guide.teachableMoments.length > 0 && (
          <motion.div
            className="rounded-lg border border-blue-200/50 dark:border-blue-800/30 bg-blue-50/40 dark:bg-blue-950/10 p-4"
            {...sectionChild(4)}
          >
            <div className="flex items-center gap-2 mb-2.5">
              <Info className="h-3.5 w-3.5 text-blue-500/70" />
              <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
                Key details
              </span>
            </div>
            <ul className="space-y-2">
              {guide.teachableMoments.map((moment, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] text-foreground/80 leading-relaxed"
                >
                  <span className="mt-1.5 block h-1 w-1 rounded-full bg-blue-400/60 shrink-0" />
                  {moment}
                </li>
              ))}
            </ul>
          </motion.div>
        )}

        {guide.examples && guide.examples.length > 0 && (
          <motion.div {...sectionChild(5)}>
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">
                Examples
              </div>
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
          </motion.div>
        )}

        {guide.tips.length > 0 && (
          <motion.div
            className="rounded-lg border border-amber-200/50 dark:border-amber-800/30 bg-amber-50/40 dark:bg-amber-950/10 p-4"
            {...sectionChild(6)}
          >
            <div className="flex items-center gap-2 mb-2.5">
              <Lightbulb className="h-3.5 w-3.5 text-amber-500/70" />
              <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
                Tips
              </span>
            </div>
            <ul className="space-y-2">
              {guide.tips.map((tip, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] text-foreground/80 leading-relaxed"
                >
                  <span className="mt-1.5 block h-1 w-1 rounded-full bg-amber-400/60 shrink-0" />
                  {tip}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </div>

      <div className="mt-12 border-b border-border/30" />
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function McpAppsGuide({
  activeStepId,
  onActiveStepChange,
  scrollToStepId,
  scrollToStepToken = 0,
  onScrollComplete,
}: McpAppsGuideProps) {
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
    MCP_APPS_STEP_ORDER,
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
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="space-y-3"
        >
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            MCP Apps
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">
            See how MCP servers deliver interactive HTML UIs into the host:
            tool metadata,{" "}
            <span className="font-medium text-foreground/80">ui://</span>{" "}
            resources, sandboxed iframes, and JSON-RPC over postMessage. Scroll
            to sync the diagram, or use{" "}
            <span className="font-medium text-foreground/80">Continue</span> in
            the header to advance.
          </p>
        </motion.div>
      </div>

      <div className="px-8 pb-16">
        {MCP_APPS_STEP_ORDER.map((stepId, index) => (
          <StepSection
            key={stepId}
            stepId={stepId}
            index={index}
            isActive={activeStepId === stepId}
            registerRef={registerSection}
          />
        ))}

        <motion.div
          className="pt-8 pb-4 text-center"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-sm text-muted-foreground/60">
            Use{" "}
            <span className="font-medium text-foreground/70">Start over</span>{" "}
            or tap nodes and edges in the diagram to jump back to a section.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
