import { Copy, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { CopyTarget } from "./suite-cases-card";

const COPY_BUTTON_CLASS =
  "shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-expanded:bg-muted aria-expanded:text-foreground";

/** A row's Copy to another suite button and its menu of target suites. */
export function CaseCopyMenu({
  caseId,
  title,
  targets,
  pending,
  onCopy,
  onOpenChange,
}: {
  caseId: string;
  title: string;
  targets: CopyTarget[];
  pending: boolean;
  onCopy(target: CopyTarget): void;
  onOpenChange?(open: boolean): void;
}) {
  const noTargets = targets.length === 0;
  const button = (
    <button
      type="button"
      data-testid={`suite-settings-case-copy-${caseId}`}
      aria-label={`Copy test case: ${title}`}
      aria-busy={pending}
      disabled={noTargets || pending}
      className={COPY_BUTTON_CLASS}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
  const tooltip = noTargets
    ? "No other suite to copy to"
    : "Copy to another suite";

  if (noTargets || pending) {
    // A disabled button gets no pointer events, so the tooltip hangs on a
    // focusable wrapper instead.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent variant="muted">{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent variant="muted">{tooltip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.suiteId}
            data-testid={`suite-settings-copy-target-${target.suiteId}`}
            disabled={target.locked}
            onSelect={() => onCopy(target)}
          >
            {target.locked ? (
              <span className="flex flex-col">
                <span>Copy to {target.name}</span>
                <span className="text-xs">
                  Runs from CI. Edit its cases in the repo.
                </span>
              </span>
            ) : (
              `Copy to ${target.name}`
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
