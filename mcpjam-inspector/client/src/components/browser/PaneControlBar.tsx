import { Hand, MousePointer2, Settings2 } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
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


/**
 * The tabs the box has open, and which one is on screen.
 *
 * The pane draws this because CHROMIUM'S IS GONE: kiosk mode is what makes
 * "the display IS the page" true for the video encoder, and it takes the tab
 * strip with it. Without this a model opening a second tab would change the
 * whole picture with nothing on screen to say why.
 *
 * Read-only. Switching tabs is the model's to do — a person who wants to drive
 * takes the lease first, and even then the browser tools are the way tabs
 * move, so a clickable strip here would be a second, quieter path into the
 * same state machine.
 */
export function PaneTabStrip({
  tabs,
}: {
  tabs: { active?: string; list?: Array<{ id: string; url: string }> } | null;
}) {
  const list = tabs?.list ?? [];
  if (list.length <= 1) return null;
  return (
    <div
      data-testid="pane-tab-strip"
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      {list.map((tab) => (
        <span
          key={tab.id}
          title={tab.url || tab.id}
          data-active={tab.id === tabs?.active ? "true" : undefined}
          className={cn(
            "max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[11px]",
            tab.id === tabs?.active
              ? "bg-muted text-foreground"
              : "text-muted-foreground",
          )}
        >
          {labelFor(tab)}
        </span>
      ))}
    </div>
  );
}

/**
 * A tab's host, or its id.
 *
 * The HOST rather than the whole URL: a strip is a few characters wide, and a
 * path carries reset tokens, share links and account ids that have no business
 * being on screen next to somebody's shoulder.
 */
function labelFor(tab: { id: string; url: string }): string {
  if (!tab.url) return tab.id;
  try {
    return new URL(tab.url).host || tab.id;
  } catch {
    return tab.id;
  }
}
