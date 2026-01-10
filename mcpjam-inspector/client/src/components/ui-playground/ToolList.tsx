/**
 * ToolList
 *
 * Displays searchable list of available tools
 */

import { RefreshCw, AlertTriangle } from "lucide-react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SearchInput } from "../ui/search-input";

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
            <div className="bg-muted/30 rounded-md p-3 mx-4 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                Only tools that render MCP Apps and ChatGPT app widgets are
                shown
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredToolNames.map((name) => {
              const tool = tools[name];
              const isSelected = selectedToolName === name;

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
                  className={`w-full text-left px-3 py-2 cursor-pointer rounded-md transition-colors ${
                    isSelected
                      ? "bg-primary/10 border border-primary/30"
                      : "hover:bg-muted/50 border border-transparent"
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
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
