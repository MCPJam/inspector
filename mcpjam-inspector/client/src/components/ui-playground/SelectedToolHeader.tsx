/**
 * SelectedToolHeader
 *
 * Compact header showing the currently selected tool with expand action,
 * optional tool-switch dropdown, save, and optional protocol selector.
 */

import { ChevronDown, ChevronLeft, Save } from "lucide-react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { cn } from "@/lib/utils";

export interface ToolSwitchListProps {
  names: string[];
  onSelect: (name: string) => void;
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
  // Protocol selector (optional)
  showProtocolSelector?: boolean;
}

export function SelectedToolHeader({
  toolName,
  onExpand,
  toolSwitchList,
  description,
  onSave,
  showProtocolSelector = false,
}: SelectedToolHeaderProps) {
  const selectedProtocol = useUIPlaygroundStore((s) => s.selectedProtocol);
  const setSelectedProtocol = useUIPlaygroundStore(
    (s) => s.setSelectedProtocol,
  );

  const toolNameControl =
    toolSwitchList && toolSwitchList.names.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hover:bg-muted/50 flex min-w-0 flex-1 items-center justify-between gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-0"
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
          {toolSwitchList.names.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() => toolSwitchList.onSelect(name)}
              className={cn(
                "cursor-pointer font-mono text-xs",
                name === toolName && "bg-accent",
              )}
            >
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <button
        type="button"
        onClick={onExpand}
        className="hover:bg-muted/50 min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-0"
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

      {/* Protocol selector (shown when tool supports both protocols) */}
      {showProtocolSelector && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <p className="flex-1 text-[11px] leading-tight text-muted-foreground">
            This tool contains ChatGPT Apps & MCP Apps (ext-apps) metadata.
            Toggle between.
          </p>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`transition-opacity ${
                    selectedProtocol === UIType.OPENAI_SDK ||
                    selectedProtocol === null
                      ? "opacity-100"
                      : "opacity-40"
                  }`}
                >
                  <img
                    src="/openai_logo.png"
                    alt="ChatGPT Apps"
                    className="h-4 w-4 object-contain"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">ChatGPT Apps</p>
                <p className="text-xs text-muted-foreground">OpenAI SDK</p>
              </TooltipContent>
            </Tooltip>

            <Switch
              checked={selectedProtocol === UIType.MCP_APPS}
              onCheckedChange={(checked) => {
                setSelectedProtocol(
                  checked ? UIType.MCP_APPS : UIType.OPENAI_SDK,
                );
              }}
              aria-label="Toggle between ChatGPT Apps and MCP Apps"
              className="data-[state=checked]:bg-input data-[state=unchecked]:bg-input dark:data-[state=checked]:bg-input/80"
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`transition-opacity ${
                    selectedProtocol === UIType.MCP_APPS
                      ? "opacity-100"
                      : "opacity-40"
                  }`}
                >
                  <img
                    src="/mcp.svg"
                    alt="MCP Apps"
                    className="h-4 w-4 object-contain"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">MCP Apps</p>
                <p className="text-xs text-muted-foreground">SEP-1865</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}
