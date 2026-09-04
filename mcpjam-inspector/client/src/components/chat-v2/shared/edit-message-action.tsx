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
 * rewinds to this message and re-runs the turn.
 *
 * The copy deliberately says nothing about branching. A rewind DOES fork the
 * session under the hood — that is how the original transcript survives in the
 * database — but the fork is an implementation detail the user is not meant to
 * see, matching how Claude Code and Codex present the same action. Earlier copy
 * here read "Edit and branch from here"; that leaked the mechanism.
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
            aria-label="Edit message"
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
