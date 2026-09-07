import { Hand, MousePointer2, Settings2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";

/** Who is driving, in the words the header says. */
export type PaneControl = "agent" | "you" | "script" | "other";

/** The header's sentence, for each way a browser can be driven. */
export function controlLabel(control: PaneControl): string {
  switch (control) {
    case "you":
      return "You have control";
    case "script":
      return "A script has control";
    case "other":
      return "Someone else has control";
    default:
      return "The agent is driving";
  }
}

/**
 * The strip above the picture: who is driving, how to take over, and the menu.
 *
 * Extracted from `BrowserPaneSurface` because the NATIVE Electron surface has
 * no picture to wrap — a real `WebContentsView` is parented into the window
 * and there is no `<img>` or `<canvas>` for a pane component to own — but it
 * needs exactly this bar, unchanged, above it. Two copies of a take-control
 * button is two chances to disagree about when it is offered, which is the one
 * thing the lease exists to be unambiguous about.
 */
export function PaneControlBar({
  control,
  onTakeControl,
  onHandBack,
  statsOpen,
  onToggleStats,
  extra,
}: {
  control: PaneControl;
  /** Offer "Take control". Omitted when there is nothing to take. */
  onTakeControl?: (() => void) | undefined;
  /** Offer "Hand back". Omitted when this pane is not the holder. */
  onHandBack?: (() => void) | undefined;
  statsOpen: boolean;
  onToggleStats: (next: boolean) => void;
  /** Engine-specific controls (the hosted tab strip, from V-5). */
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
      <span className="text-xs text-muted-foreground">
        {controlLabel(control)}
      </span>
      <div className="flex items-center gap-2">
        {extra}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Browser view settings"
              data-testid="pane-settings"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={statsOpen}
              onCheckedChange={(next) => onToggleStats(Boolean(next))}
              data-testid="pane-stats-toggle"
            >
              Stats for nerds
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onHandBack ? (
          <Button size="sm" variant="outline" onClick={onHandBack}>
            <Hand className="mr-1.5 h-3.5 w-3.5" />
            Hand back
          </Button>
        ) : onTakeControl ? (
          <Button size="sm" onClick={onTakeControl}>
            <MousePointer2 className="mr-1.5 h-3.5 w-3.5" />
            Take control
          </Button>
        ) : null}
      </div>
    </div>
  );
}
