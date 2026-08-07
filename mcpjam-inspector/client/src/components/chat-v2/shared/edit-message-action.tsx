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
 * rewinds the thread to this message and re-runs the turn. Unlike
 * `SaveAsTestCaseAction` this needs no auth or project — it works on any
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
            aria-label="Edit this message"
            disabled={disabled}
            className="flex size-6 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onClick}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Edit message</TooltipContent>
    </Tooltip>
  );
}
