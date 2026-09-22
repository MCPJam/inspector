/**
 * SelectedToolHeader
 *
 * Compact header showing the currently selected tool with expand action,
 * optional tool-switch dropdown, and save.
 */

import { ChevronDown, ChevronLeft, Save } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mcpjam/design-system/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ToolSwitchItem {
  id: string;
  label: string;
  description?: string;
}

export interface ToolSwitchListProps {
  items: ToolSwitchItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

interface SelectedToolHeaderProps {
  toolName: string;
  onExpand: () => void;
  /** When set, the tool name opens a menu to switch to another tool */
  toolSwitchList?: ToolSwitchListProps;
  // Optional description shown below tool name
  description?: string;
  // Optional save action
  onSave?: () => void;
}

export function SelectedToolHeader({
  toolName,
  onExpand,
  toolSwitchList,
  description,
  onSave,
}: SelectedToolHeaderProps) {
  const toolNameControl =
    toolSwitchList && toolSwitchList.items.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hover:bg-muted/50 flex min-w-0 flex-1 items-center justify-between gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            title="Switch tool"
          >
            <code className="block min-w-0 flex-1 truncate text-xs font-mono font-medium text-foreground">
              {toolName}
            </code>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(280px,45vh)] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
        >
          {toolSwitchList.items.map((item) => {
            const selected = toolSwitchList.selectedId
              ? item.id === toolSwitchList.selectedId
              : item.label === toolName || item.id === toolName;
            return (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => toolSwitchList.onSelect(item.id)}
                className={cn(
                  "cursor-pointer font-mono text-xs",
                  selected && "bg-accent",
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.label}</span>
                  {item.description ? (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <button
        type="button"
        onClick={onExpand}
        className="hover:bg-muted/50 min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        title="Show full tool list"
      >
        <code className="block truncate text-xs font-mono font-medium text-foreground">
          {toolName}
        </code>
      </button>
    );

  return (
    <div className="flex-shrink-0 border-b border-border bg-muted/30">
      {/* Tool name header */}
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              onClick={onExpand}
              title="Show full tool list"
              aria-label="Show full tool list"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            {toolNameControl}
          </div>
          {description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {onSave && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 flex-shrink-0 p-0 text-muted-foreground hover:text-foreground"
                onClick={onSave}
              >
                <Save className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save request</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
