/**
 * SelectedToolHeader
 *
 * Compact header showing the currently selected tool with expand/clear actions
 * and optional protocol selector for tools supporting both OpenAI SDK and MCP Apps
 */

import { X } from "lucide-react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

interface SelectedToolHeaderProps {
  toolName: string;
  onExpand: () => void;
  onClear: () => void;
  // Protocol selector (optional)
  showProtocolSelector?: boolean;
}

export function SelectedToolHeader({
  toolName,
  onExpand,
  onClear,
  showProtocolSelector = false,
}: SelectedToolHeaderProps) {
  const selectedProtocol = useUIPlaygroundStore((s) => s.selectedProtocol);
  const setSelectedProtocol = useUIPlaygroundStore(
    (s) => s.setSelectedProtocol,
  );
  return (
    <div className="border-b border-border bg-muted/30 flex-shrink-0">
      {/* Tool name header */}
      <div className="px-3 py-2 flex items-center gap-2">
        <button
          onClick={onExpand}
          className="flex-1 min-w-0 hover:bg-muted/50 rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-left"
          title="Click to change tool"
        >
          <code className="text-xs font-mono font-medium text-foreground truncate block">
            {toolName}
          </code>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground flex-shrink-0"
          onClick={onClear}
          title="Clear selection"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Protocol selector (shown when tool supports both protocols) */}
      {showProtocolSelector && (
        <div className="px-3 py-2.5 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground leading-tight flex-1">
            This tool contains ChatGPT Apps & MCP Apps (ext-apps) metadata.
            Toggle between.
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
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
