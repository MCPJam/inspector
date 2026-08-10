import { GitCompare } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { buildHostComparePath, navigateApp } from "@/lib/app-navigation";

/**
 * Side-by-side compare for the clients a suite fans out over.
 *
 * A sibling of the composer rather than something inside it: comparing clients
 * is an evals affordance, and the shared strip has no business knowing about
 * the host-compare route. Renders nothing below two clients, where there is
 * nothing to compare.
 */
export function CompareClientsButton({ hostIds }: { hostIds: string[] }) {
  if (hostIds.length < 2) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-foreground outline-none transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring dark:bg-background"
          aria-label="Compare attached clients"
          onClick={() => navigateApp(buildHostComparePath(hostIds))}
        >
          <GitCompare className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Compare attached clients side by side</TooltipContent>
    </Tooltip>
  );
}
