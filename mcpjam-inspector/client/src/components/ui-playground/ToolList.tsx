/**
 * ToolList
 *
 * Displays searchable list of available tools
 */

import { RefreshCw } from "lucide-react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SearchInput } from "../ui/search-input";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface ToolListProps {
  tools: Record<string, Tool>;
  toolNames: string[];
  filteredToolNames: string[];
  selectedToolName: string | null;
  fetchingTools: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSelectTool: (name: string) => void;
  onCollapseList: () => void;
}

export function ToolList({
  tools,
  toolNames,
  filteredToolNames,
  selectedToolName,
  fetchingTools,
  searchQuery,
  onSearchQueryChange,
  onSelectTool,
  onCollapseList,
}: ToolListProps) {
  return (
    <div className="h-full flex flex-col">
      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <SearchInput
          value={searchQuery}
          onValueChange={onSearchQueryChange}
          placeholder="Search tools..."
        />
      </div>

      {/* Tool List */}
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {fetchingTools ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
            <p className="text-xs text-muted-foreground">Loading tools...</p>
          </div>
        ) : filteredToolNames.length === 0 ? (
          <div className="text-center py-8 space-y-4">
            <p className="text-xs text-muted-foreground">
              {toolNames.length === 0
                ? "No tools found. Try refreshing and make sure the server is running."
                : "No tools match your search"}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredToolNames.map((name) => {
              const tool = tools[name];
              const isSelected = selectedToolName === name;
              const uiType = detectUIType(tool._meta, undefined);

              return (
                <button
                  key={name}
                  onClick={() => {
                    if (isSelected) {
                      onCollapseList();
                    } else {
                      onSelectTool(name);
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                    isSelected
                      ? "bg-primary/10 border border-primary/30 cursor-pointer"
                      : "hover:bg-muted/50 border border-transparent cursor-pointer"
                  }`}
                >
                  <code className="text-xs font-mono font-medium truncate block">
                    {name}
                  </code>
                  {tool.description && (
                    <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                      {tool.description}
                    </p>
                  )}
                  {uiType && (
                    <div className="flex items-center gap-1.5 mt-2">
                      {(uiType === UIType.OPENAI_SDK ||
                        uiType === UIType.OPENAI_SDK_AND_MCP_APPS) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center">
                              <img
                                src="/openai_logo.png"
                                alt="ChatGPT Apps"
                                className="h-3.5 w-3.5 object-contain opacity-60"
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="text-xs">ChatGPT Apps</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {(uiType === UIType.MCP_APPS ||
                        uiType === UIType.OPENAI_SDK_AND_MCP_APPS ||
                        uiType === UIType.MCP_UI) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center">
                              <img
                                src="/mcp.svg"
                                alt="MCP Apps"
                                className="h-3.5 w-3.5 object-contain opacity-60"
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="text-xs">
                              {uiType === UIType.MCP_UI ? "MCP UI" : "MCP Apps"}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
