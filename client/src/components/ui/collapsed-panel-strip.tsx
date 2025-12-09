import { PanelRightOpen, PanelLeftOpen } from "lucide-react";
import { Button } from "./button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

interface CollapsedPanelStripProps {
  onOpen: () => void;
  tooltipText?: string;
  /** Which side the panel opens from. "right" means the strip is on the right and opens a right panel. */
  side?: "left" | "right";
}

export function CollapsedPanelStrip({
  onOpen,
  tooltipText = "Show panel",
  side = "right",
}: CollapsedPanelStripProps) {
  const Icon = side === "right" ? PanelRightOpen : PanelLeftOpen;
  const borderClass = side === "right" ? "border-l" : "border-r";
  const tooltipSide = side === "right" ? "left" : "right";

  return (
    <div className={`flex items-center ${borderClass} border-border`}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpen}
              className="h-full px-1 rounded-none cursor-pointer"
            >
              <Icon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>
            <p>{tooltipText}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
