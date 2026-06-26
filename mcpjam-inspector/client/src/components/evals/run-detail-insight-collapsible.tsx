import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";
import {
  insightHighlightAccentClass,
  insightHighlightBodyClass,
  insightHighlightHeaderRowClass,
  insightHighlightSectionClass,
  insightHighlightSubtitleClass,
  insightHighlightTitleClass,
  insightHighlightTriggerClass,
} from "./insight-highlight-chrome";

/**
 * Collapsible wrapper for run-level AI narratives in the run detail pane.
 */
export function RunDetailInsightCollapsible({
  title,
  subtitle,
  defaultOpen = true,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shouldReduceMotion = useReducedMotion();

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(insightHighlightSectionClass, className)}
    >
      <div className={insightHighlightAccentClass} aria-hidden />
      <div className={insightHighlightHeaderRowClass}>
        <CollapsibleTrigger asChild>
          <motion.button
            type="button"
            className={cn(insightHighlightTriggerClass, "w-full")}
            whileTap={
              shouldReduceMotion
                ? undefined
                : { scale: 0.992, transition: { duration: 0.08 } }
            }
            transition={{ type: "spring", stiffness: 520, damping: 32 }}
          >
            <motion.span
              className="inline-flex shrink-0 text-muted-foreground"
              aria-hidden
              initial={false}
              animate={{ rotate: open ? 0 : -90 }}
              transition={
                shouldReduceMotion
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 420, damping: 28 }
              }
            >
              <ChevronDown className="h-4 w-4" />
            </motion.span>
            <div className="min-w-0 flex-1">
              <span className={insightHighlightTitleClass}>{title}</span>
              {subtitle ? (
                <p className={insightHighlightSubtitleClass}>{subtitle}</p>
              ) : null}
            </div>
          </motion.button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className={insightHighlightBodyClass}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
