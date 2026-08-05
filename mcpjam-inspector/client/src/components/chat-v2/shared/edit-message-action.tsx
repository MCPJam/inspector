import { Pencil } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

type EditMessageActionProps = {
  onClick: () => void;
  disabled?: boolean;
};

/**
 * Per-user-message action that swaps the bubble for an inline editor. Saving
 * rewinds to this message and re-runs the turn in a NEW branch — the original
 * thread keeps its transcript. The copy says "branch" for that reason: the
 * consequence has to be legible before the click.
 *
 * Unlike `SaveAsTestCaseAction` this needs no auth or project — it works on any
 * transcript, hosted or local.
 */
export function EditMessageAction({
  onClick,
  disabled = false,
}: EditMessageActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <button
            type="button"
            aria-label="Edit this message and branch the thread"
            disabled={disabled}
            className="flex size-6 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onClick}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Edit and branch from here</TooltipContent>
    </Tooltip>
  );
}
