import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Wrench, RefreshCw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SearchInput } from "../ui/search-input";
import { ResizablePanel } from "../ui/resizable";
import { ToolItem } from "./ToolItem";
import { SavedRequestItem } from "./SavedRequestItem";
import type { SavedRequest } from "@/lib/request-types";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { usePostHog } from "posthog-js/react";
interface ToolsSidebarProps {
  activeTab: "tools" | "saved";
  onChangeTab: (tab: "tools" | "saved") => void;
  tools: Record<string, Tool>;
  toolNames: string[];
  filteredToolNames: string[];
  selectedToolName?: string;
  fetchingTools: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onRefresh: () => void;
  onSelectTool: (name: string) => void;
  savedRequests: SavedRequest[];
  highlightedRequestId: string | null;
  onLoadRequest: (req: SavedRequest) => void;
  onRenameRequest: (req: SavedRequest) => void;
  onDuplicateRequest: (req: SavedRequest) => void;
  onDeleteRequest: (id: string) => void;
}

export function ToolsSidebar({
  activeTab,
  onChangeTab,
  tools,
  toolNames,
  filteredToolNames,
  selectedToolName,
  fetchingTools,
  searchQuery,
  onSearchQueryChange,
  onRefresh,
  onSelectTool,
  savedRequests,
  highlightedRequestId,
  onLoadRequest,
  onRenameRequest,
  onDuplicateRequest,
  onDeleteRequest,
}: ToolsSidebarProps) {
  const posthog = usePostHog();
  return (
    <ResizablePanel defaultSize={35} minSize={20} maxSize={55}>
      <div className="h-full flex flex-col border-r border-border bg-background">
        <div className="border-b border-border flex-shrink-0">
          <div className="flex">
            <button
              onClick={() => onChangeTab("tools")}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                activeTab === "tools"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Tools
            </button>
            <button
              onClick={() => onChangeTab("saved")}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                activeTab === "saved"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Saved Requests
              {savedRequests.length > 0 && (
                <span className="ml-2 bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-mono">
                  {savedRequests.length}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="px-4 py-4 border-b border-border bg-background space-y-3 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Wrench className="h-3 w-3 text-muted-foreground" />
              <h2 className="text-xs font-semibold text-foreground">Tools</h2>
              <Badge variant="secondary" className="text-xs font-mono">
                {activeTab === "tools"
                  ? toolNames.length
                  : savedRequests.length}
              </Badge>
            </div>
            <Button
              onClick={() => {
                posthog.capture("refresh_tools_clicked", {
                  location: "tools_sidebar",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                onRefresh();
              }}
              variant="ghost"
              size="sm"
              disabled={fetchingTools}
            >
              {activeTab === "tools" && (
                <RefreshCw
                  className={`h-3 w-3 ${fetchingTools ? "animate-spin" : ""} cursor-pointer`}
                />
              )}
            </Button>
          </div>
          <SearchInput
            value={searchQuery}
            onValueChange={onSearchQueryChange}
            placeholder="Search tools by name or description"
          />
        </div>

        <div className="flex-1 overflow-hidden">
          {activeTab === "tools" ? (
            <ScrollArea className="h-full">
              <div className="p-2 pb-16">
                {fetchingTools ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                      <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
                    </div>
                    <p className="text-xs text-muted-foreground font-semibold mb-1">
                      Loading tools...
                    </p>
                    <p className="text-xs text-muted-foreground/70">
                      Fetching available tools from server
                    </p>
                  </div>
                ) : filteredToolNames.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-sm text-muted-foreground">
                      {tools && toolNames.length === 0
                        ? "No tools were found. Try refreshing. Make sure you selected the correct server and the server is running."
                        : "No tools match your search."}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2">
                    {filteredToolNames.map((name) => (
                      <ToolItem
                        key={name}
                        tool={tools[name]}
                        name={name}
                        isSelected={selectedToolName === name}
                        onClick={() => onSelectTool(name)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : (
            <ScrollArea className="h-full">
              <div className="p-3 space-y-1 pb-16">
                {savedRequests.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-sm text-muted-foreground">
                      No saved requests yet.
                    </p>
                  </div>
                ) : (
                  savedRequests.map((request) => (
                    <SavedRequestItem
                      key={request.id}
                      request={request}
                      isHighlighted={highlightedRequestId === request.id}
                      onLoad={onLoadRequest}
                      onRename={onRenameRequest}
                      onDuplicate={onDuplicateRequest}
                      onDelete={onDeleteRequest}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </ResizablePanel>
  );
}
