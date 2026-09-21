import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";

/**
 * The one header recipe for every tool origin in the Playground list.
 *
 * Servers, Browser, WebMCP, and harness built-ins are different kinds of
 * thing. The row under them stays the same so the eye learns the grouping
 * instead of hunting for a caption. The group itself collapses: a long page
 * registry should not bury the verbs below it.
 */
export function ToolSourceHeader({
  title,
  chip,
  chipTitle,
  className,
  defaultOpen = true,
  children,
}: {
  title: string;
  chip?: string;
  chipTitle?: string;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={className}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 px-3 pb-1 text-left",
          "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        )}
      >
        <ChevronRight
          className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {chip ? (
          <Badge variant="outline" title={chipTitle ?? chip}>
            {chip}
          </Badge>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
