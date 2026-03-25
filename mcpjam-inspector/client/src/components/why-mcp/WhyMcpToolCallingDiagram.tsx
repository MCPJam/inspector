import { memo, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Brain, MessageSquare, Wrench } from "lucide-react";
import {
  springGentle,
  springSnappy,
  useDiagramMotion,
  VIEWPORT_ONCE,
} from "./diagram-motion";

const STAGE_COUNT = 4;

export const WhyMcpToolCallingDiagram = memo(
  function WhyMcpToolCallingDiagram() {
    const { reduce } = useDiagramMotion();
    const [stage, setStage] = useState(0);

    useEffect(() => {
      if (reduce) return;
      const id = window.setInterval(
        () => setStage((s) => (s + 1) % STAGE_COUNT),
        2000,
      );
      return () => window.clearInterval(id);
    }, [reduce]);

    return (
      <div
        className="overflow-hidden rounded-xl border border-border/70 bg-card/40 dark:bg-card/25"
        role="img"
        aria-label="With tools: user asks about order 4521, model calls get_order_status, host returns JSON, model replies with shipping details."
      >
        <div className="px-4 pb-5 pt-4 sm:px-5">
          <div className="relative mx-auto w-full max-w-md">
            <div
              className="absolute bottom-6 left-[1.375rem] top-5 w-px bg-violet-400/20 dark:bg-violet-500/15"
              aria-hidden
            />

            <div className="relative space-y-4">
              <StoryBlock
                icon={MessageSquare}
                kicker="User"
                active={reduce || stage === 0}
              >
                <p className="text-[13px] leading-snug text-foreground/90">
                  &ldquo;What&apos;s the status of order #4521?&rdquo;
                </p>
              </StoryBlock>

              <StoryBlock
                icon={Brain}
                kicker="Model"
                subtitle="Emits a structured call — not the final answer yet."
                active={reduce || stage === 1}
              >
                <code className="block rounded-lg border border-violet-200/45 bg-violet-500/[0.06] px-2.5 py-2 text-[11px] font-mono leading-relaxed text-violet-900/90 dark:border-violet-800/35 dark:bg-violet-500/10 dark:text-violet-100/90">
                  get_order_status(order_id=&quot;4521&quot;)
                </code>
              </StoryBlock>

              <StoryBlock
                icon={Wrench}
                kicker="Your host"
                subtitle="Executes the tool and passes the result back."
                active={reduce || stage === 2}
              >
                <p className="rounded-lg border border-border/55 bg-muted/25 px-2.5 py-2 text-[11px] font-mono leading-relaxed text-foreground/80 dark:bg-muted/20">
                  {`{ shipped: true, tracking: "XYZ" }`}
                </p>
              </StoryBlock>

              <StoryBlock
                icon={MessageSquare}
                kicker="Model → user"
                subtitle="Finishes the message with real data."
                active={reduce || stage === 3}
              >
                <p className="border-l-2 border-l-violet-400/45 pl-3 text-[13px] leading-snug text-foreground/90 dark:border-l-violet-500/40">
                  &ldquo;Order #4521 shipped yesterday, tracking number
                  XYZ.&rdquo;
                </p>
              </StoryBlock>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

function StoryBlock({
  icon: Icon,
  kicker,
  subtitle,
  children,
  active,
}: {
  icon: React.ElementType;
  kicker: string;
  subtitle?: string;
  children: React.ReactNode;
  active: boolean;
}) {
  return (
    <motion.div
      className="relative grid grid-cols-[auto_1fr] gap-3 pl-8"
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT_ONCE}
      transition={springGentle}
    >
      <div className="pointer-events-none absolute left-0 top-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-xl border border-border/70 bg-card shadow-sm dark:bg-card">
        <Icon
          className={`h-3.5 w-3.5 transition-colors duration-300 ${
            active
              ? "text-violet-600 dark:text-violet-400"
              : "text-muted-foreground/50"
          }`}
        />
      </div>
      <motion.div
        className="min-w-0 rounded-xl border border-border/50 bg-background/50 px-3 py-2.5 dark:bg-background/25"
        initial={false}
        animate={{
          boxShadow: active
            ? "0 0 0 1px rgba(139, 92, 246, 0.24), 0 10px 28px -14px rgba(139, 92, 246, 0.22)"
            : "0 0 0 0px rgba(0,0,0,0)",
        }}
        transition={springSnappy}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {kicker}
        </p>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
        <div className={subtitle ? "mt-2" : "mt-1.5"}>{children}</div>
      </motion.div>
    </motion.div>
  );
}
