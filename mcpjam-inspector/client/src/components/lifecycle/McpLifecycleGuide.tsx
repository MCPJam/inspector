import { useRef, useEffect, useCallback } from "react";
import { ArrowRight, Lightbulb, Info } from "lucide-react";
import { motion } from "framer-motion";
import {
  HTTP_STEP_ORDER,
  LIFECYCLE_GUIDE_METADATA,
  PHASE_ACCENT,
  type McpLifecycleStepGuide,
} from "./mcp-lifecycle-guide-data";
import type { McpLifecycleStep20250326 } from "./mcp-lifecycle-data";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpLifecycleGuideProps {
  activeStepId: string | undefined;
  onActiveStepChange: (stepId: string) => void;
  scrollToStepId: string | undefined;
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
// useScrollSpy — IntersectionObserver-based scroll tracking
// ---------------------------------------------------------------------------

function useScrollSpy(
  sectionIds: readonly string[],
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  onActiveChange: (id: string) => void,
  enabled: boolean,
) {
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const rafId = useRef(0);

  const registerSection = useCallback((id: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(id, el);
    else sectionRefs.current.delete(id);
  }, []);

  useEffect(() => {
    if (!enabled || !scrollContainerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        cancelAnimationFrame(rafId.current);
        rafId.current = requestAnimationFrame(() => {
          let bestEntry: IntersectionObserverEntry | null = null;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              if (
                !bestEntry ||
                entry.intersectionRatio > bestEntry.intersectionRatio
              ) {
                bestEntry = entry;
              }
            }
          }
          if (bestEntry) {
            const id = bestEntry.target.getAttribute("data-step-id");
            if (id) onActiveChange(id);
          }
        });
      },
      {
        root: scrollContainerRef.current,
        rootMargin: "-10% 0px -60% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const id of sectionIds) {
      const el = sectionRefs.current.get(id);
      if (el) observer.observe(el);
    }

    return () => {
      cancelAnimationFrame(rafId.current);
      observer.disconnect();
    };
  }, [sectionIds, enabled, onActiveChange, scrollContainerRef]);

  return { registerSection };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DirectionIndicator({
  direction,
  order,
}: {
  direction: "client-to-server" | "server-to-client";
  order: number;
}) {
  const isToServer = direction === "client-to-server";
  return (
    <motion.div
      className="flex items-center gap-2 text-muted-foreground/60"
      {...sectionChild(order)}
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

function StepSection({
  stepId,
  index,
  isActive,
  registerRef,
}: {
  stepId: McpLifecycleStep20250326;
  index: number;
  isActive: boolean;
  registerRef: (id: string, el: HTMLElement | null) => void;
}) {
  const guide = LIFECYCLE_GUIDE_METADATA[stepId] as
    | McpLifecycleStepGuide
    | undefined;
  if (!guide) return null;

  const phaseColor =
    PHASE_ACCENT[guide.phase as keyof typeof PHASE_ACCENT] ?? "#94a3b8";
  const direction =
    stepId === "initialize_result" || stepId === "operation_response"
      ? "server-to-client"
      : "client-to-server";

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
      {/* Active indicator — phase-colored left border */}
      <motion.div
        className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full"
        animate={{
          backgroundColor: isActive ? phaseColor : "transparent",
          scaleY: isActive ? 1 : 0.3,
          opacity: isActive ? 1 : 0,
        }}
        transition={{ duration: 0.35 }}
      />

      <div className="pl-5 space-y-5">
        {/* Phase badge + step number */}
        <motion.div className="flex items-center gap-2" {...sectionChild(0)}>
          <span
            className="block h-2 w-2 rounded-full"
            style={{ backgroundColor: phaseColor }}
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: phaseColor }}
          >
            {guide.phase}
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            Step {index + 1}
          </span>
        </motion.div>

        {/* Title */}
        <motion.h2
          className="text-xl font-semibold tracking-tight text-foreground -mt-1"
          {...sectionChild(1)}
        >
          {guide.title}
        </motion.h2>

        {/* Summary */}
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed max-w-prose"
          {...sectionChild(2)}
        >
          {guide.summary}
        </motion.p>

        {/* Direction */}
        <DirectionIndicator direction={direction} order={3} />

        {/* Code example */}
        {guide.codeExample && (
          <motion.div {...sectionChild(4)}>
            <pre
              className="rounded-lg border border-border bg-muted/30 p-4 text-[11px] leading-relaxed font-mono text-foreground/70 overflow-x-auto"
              style={{ borderLeftWidth: 3, borderLeftColor: phaseColor }}
            >
              {guide.codeExample}
            </pre>
          </motion.div>
        )}

        {/* Teachable moments */}
        {guide.teachableMoments.length > 0 && (
          <motion.div
            className="rounded-lg border border-blue-200/50 dark:border-blue-800/30 bg-blue-50/40 dark:bg-blue-950/10 p-4"
            {...sectionChild(5)}
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

        {/* Table */}
        {guide.table && (
          <motion.div {...sectionChild(6)}>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="bg-muted/40 px-4 py-2">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {guide.table.caption}
                </span>
              </div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    {guide.table.headers.map((h, i) => (
                      <th
                        key={i}
                        className="text-left px-4 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {guide.table.rows.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className={`px-4 py-2 ${j === 0 ? "font-mono text-[12px] text-foreground/80" : "text-muted-foreground"}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}

        {/* Tips */}
        {guide.tips.length > 0 && (
          <motion.div
            className="rounded-lg border border-amber-200/50 dark:border-amber-800/30 bg-amber-50/40 dark:bg-amber-950/10 p-4"
            {...sectionChild(7)}
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

      {/* Section divider */}
      <div className="mt-12 border-b border-border/30" />
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function McpLifecycleGuide({
  activeStepId,
  onActiveStepChange,
  scrollToStepId,
  onScrollComplete,
}: McpLifecycleGuideProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScroll = useRef(false);

  // Scroll spy — tracks which section is in the viewport
  const handleActiveChange = useCallback(
    (id: string) => {
      if (isProgrammaticScroll.current) return;
      onActiveStepChange(id);
    },
    [onActiveStepChange],
  );

  const { registerSection } = useScrollSpy(
    HTTP_STEP_ORDER,
    scrollContainerRef,
    handleActiveChange,
    true,
  );

  // Programmatic scroll — triggered by diagram click
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
  }, [scrollToStepId, onScrollComplete]);

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto scrollbar-thin"
    >
      {/* Hero */}
      <div className="px-8 pt-8 pb-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="space-y-3"
        >
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            HTTP Connection Lifecycle
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">
            Walk through the five steps of an HTTP-based MCP connection — from
            the initial handshake to normal operations and shutdown. Scroll
            through each step and watch the diagram follow along.
          </p>
        </motion.div>
      </div>

      {/* Step sections */}
      <div className="px-8 pb-16">
        {HTTP_STEP_ORDER.map((stepId, index) => (
          <StepSection
            key={stepId}
            stepId={stepId}
            index={index}
            isActive={activeStepId === stepId}
            registerRef={registerSection}
          />
        ))}

        {/* Outro */}
        <motion.div
          className="pt-8 pb-4 text-center"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-sm text-muted-foreground/60">
            That&apos;s the complete HTTP MCP lifecycle. Click any step in the
            diagram to jump back.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
