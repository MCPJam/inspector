import { useRef, useEffect, useCallback } from "react";
import { ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { useScrollSpy } from "@/hooks/use-scroll-spy";
import {
  HTTP_STEP_ORDER,
  LIFECYCLE_GUIDE_METADATA,
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
  /** Incremented when scrolling to the same step again (e.g. Reset on step 1). */
  scrollToStepToken?: number;
  onScrollComplete: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DirectionIndicator({
  direction,
}: {
  direction: "client-to-server" | "server-to-client";
}) {
  const isToServer = direction === "client-to-server";
  return (
    <div className="flex items-center gap-2 text-muted-foreground/60">
      <span className="text-[11px] font-medium">
        {isToServer ? "Client" : "Server"}
      </span>
      <ArrowRight className="h-3 w-3" />
      <span className="text-[11px] font-medium">
        {isToServer ? "Server" : "Client"}
      </span>
    </div>
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
      transition={{ duration: 0.5 }}
    >
      {/* Active indicator — neutral left border */}
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
        {/* Step counter */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground font-mono">
            Step {index + 1}
          </span>
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold tracking-tight text-foreground -mt-1">
          {guide.title}
        </h2>

        {/* Summary */}
        <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">
          {guide.summary}
        </p>

        {/* Direction */}
        <DirectionIndicator direction={direction} />

        {/* Code example */}
        {guide.codeExample && (
          <pre className="rounded-lg border border-border bg-muted/30 p-4 text-[11px] leading-relaxed font-mono text-foreground/70 overflow-x-auto">
            {guide.codeExample}
          </pre>
        )}

        {/* Teachable moments */}
        {guide.teachableMoments.length > 0 && (
          <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
            {guide.teachableMoments.map((moment, i) => (
              <li key={i}>{moment}</li>
            ))}
          </ul>
        )}

        {/* Table */}
        {guide.table && (
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
        )}

        {/* Tips */}
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
  scrollToStepToken = 0,
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
  }, [scrollToStepId, scrollToStepToken, onScrollComplete]);

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto scrollbar-thin"
    >
      {/* Hero */}
      <div className="px-8 pt-8 pb-4">
        <div className="space-y-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            HTTP Connection Lifecycle
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">
            Walk through the five main steps of an HTTP MCP connection. Scroll
            to move through the guide and sync the diagram, or use{" "}
            <span className="font-medium text-foreground/80">Continue</span> in
            the header to jump to the next step.
          </p>
        </div>
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
        <div className="pt-8 pb-4 text-center">
          <p className="text-sm text-muted-foreground/60">
            That&apos;s the complete HTTP MCP lifecycle. Use{" "}
            <span className="font-medium text-foreground/70">Start over</span>{" "}
            in the header or click any step in the diagram to jump back.
          </p>
        </div>
      </div>
    </div>
  );
}
