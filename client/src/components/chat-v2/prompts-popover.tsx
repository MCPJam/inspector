import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/chat-utils";
import { MessageSquareCode, ListChecks } from "lucide-react";
import { NamespacedPrompt } from "@/components/ChatTabV2";

interface PromptsPopoverProps {
  anchor: { x: number; y: number };
  open: boolean;
  setOpen: (open: boolean) => void;
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  isHovering: boolean;
  setIsHovering: (hovering: boolean) => void;
  prompts: NamespacedPrompt[];
  onPromptClick: (promptNamespacedName: string) => void;
}

export function PromptsPopover({
  anchor,
  open,
  setOpen,
  highlightedIndex,
  setHighlightedIndex,
  isHovering,
  setIsHovering,
  prompts,
  onPromptClick,
}: PromptsPopoverProps) {

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {/* Invisible anchor for dropdown positioning */}
        <span
          style={{
            position: "absolute",
            left: anchor.x,
            top: anchor.y,
            width: 0,
            height: 0,
            zIndex: 1,
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-auto min-w-[200px] p-1"
      >
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          SELECT A PROMPT
        </div>
        <div className="flex flex-col">
          {prompts.map((prompt, index) => (
              <Tooltip key={prompt.namespacedName} delayDuration={1000}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={
                      cn(
                        "flex items-center gap-2 rounded-sm px-2 max-w-[300px] py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground",
                        highlightedIndex === index && !isHovering
                          ? "bg-accent text-accent-foreground"
                          : "",
                      )
                    }
                    onClick={() => onPromptClick(prompt.namespacedName)}
                    onMouseEnter={() => {
                      if (isHovering) {
                        setHighlightedIndex(index);
                      }
                    }}
                  >
                    <MessageSquareCode size={16} className="shrink-0" />
                    <span className="flex-1 text-left truncate">{prompt.namespacedName}</span>
                    {prompt.arguments && prompt.arguments.length > 0 && (
                      <ListChecks
                        size={14}
                        className="text-muted-foreground shrink-0 ml-2"
                        aria-label="Requires inputs"
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{prompt.description}</TooltipContent>
              </Tooltip>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
