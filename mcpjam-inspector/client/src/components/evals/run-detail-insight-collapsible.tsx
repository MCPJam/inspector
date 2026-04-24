import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";

/**
 * Same interaction pattern as {@link SuiteInsightsCollapsible} for run-level AI narratives.
 */
export function RunDetailInsightCollapsible({
  title,
  defaultOpen = true,
  className,
  children,
}: {
  title: string;
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
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground",
        className,
      )}
    >
      <CollapsibleTrigger asChild>
        <motion.button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-t-lg px-3 py-2.5 text-left outline-none hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring"
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
          <span className="text-xs font-semibold text-muted-foreground">
            {title}
          </span>
        </motion.button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/50 px-3 pb-3 pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
