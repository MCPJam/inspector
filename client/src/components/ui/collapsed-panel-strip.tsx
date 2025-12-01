import { PanelRightOpen } from "lucide-react";
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
}

export function CollapsedPanelStrip({
  onOpen,
  tooltipText = "Show JSON-RPC panel",
}: CollapsedPanelStripProps) {
  return (
    <div className="flex items-center border-l border-border">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpen}
              className="h-full px-1 rounded-none cursor-pointer"
            >
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>{tooltipText}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
