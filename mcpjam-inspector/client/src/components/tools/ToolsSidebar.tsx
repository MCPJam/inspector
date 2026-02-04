import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RefreshCw, Play, Clock, PanelLeftClose, Save } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SearchInput } from "../ui/search-input";
import { Input } from "../ui/input";
import { ToolItem } from "./ToolItem";
import { SavedRequestItem } from "./SavedRequestItem";
import type { SavedRequest } from "@/lib/types/request-types";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { usePostHog } from "posthog-js/react";
import { SelectedToolHeader } from "../ui-playground/SelectedToolHeader";
import { ParametersForm } from "../ui-playground/ParametersForm";
import type { FormField } from "@/lib/tool-form";

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
  displayedToolCount: number;
  sentinelRef: RefObject<HTMLDivElement | null>;
  loadingMore: boolean;
  cursor: string;
  // Parameters form props (for full-page replacement pattern)
  formFields?: FormField[];
  onFieldChange?: (name: string, value: unknown) => void;
  onToggleField?: (name: string, isSet: boolean) => void;
  loading?: boolean;
  waitingOnElicitation?: boolean;
  onExecute?: () => void;
  onSave?: () => void;
  executeAsTask?: boolean;
  onExecuteAsTaskChange?: (value: boolean) => void;
  taskRequired?: boolean;
  taskTtl?: number;
  onTaskTtlChange?: (value: number) => void;
  serverSupportsTaskToolCalls?: boolean;
  // Collapsible sidebar
  onClose?: () => void;
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
  displayedToolCount,
  sentinelRef,
  loadingMore,
  cursor,
  // Parameters form props
  formFields,
  onFieldChange,
  onToggleField,
  loading,
  waitingOnElicitation,
  onExecute,
  onSave,
  executeAsTask,
  onExecuteAsTaskChange,
  taskRequired,
  taskTtl,
  onTaskTtlChange,
  serverSupportsTaskToolCalls,
  onClose,
}: ToolsSidebarProps) {
  const posthog = usePostHog();
  const selectedTool = selectedToolName ? tools[selectedToolName] : null;

  const canExecute = !!selectedToolName && !!onExecute;
  const canSave = !!selectedToolName && !!onSave;

  const handleExecute = () => {
    if (!onExecute) return;
    posthog.capture("execute_tool", {
      location: "tools_sidebar",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      as_task: executeAsTask ?? false,
    });
    onExecute();
  };

  const handleSave = () => {
    if (!onSave) return;
    posthog.capture("save_tool_button_clicked", {
      location: "tools_sidebar",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    onSave();
  };

  const handleRefresh = () => {
    posthog.capture("refresh_tools_clicked", {
      location: "tools_sidebar",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    onRefresh();
  };

  return (
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* Header with tabs and actions - App Builder style */}
      <div className="border-b border-border flex-shrink-0">
        <div className="px-2 py-1.5 flex items-center gap-2">
          {/* Tabs */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onChangeTab("tools")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "tools"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Tools
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {toolNames.length}
              </span>
            </button>
            <button
              onClick={() => onChangeTab("saved")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "saved"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Saved
              {savedRequests.length > 0 && (
                <span className="ml-1 text-[10px] font-mono opacity-70">
                  {savedRequests.length}
                </span>
              )}
            </button>
          </div>

          {/* Secondary actions */}
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            <Button
              onClick={handleSave}
              disabled={!canSave}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Save request"
            >
              <Save className="h-3.5 w-3.5" />
            </Button>
            <Button
              onClick={handleRefresh}
              variant="ghost"
              size="sm"
              disabled={fetchingTools}
              className="h-7 w-7 p-0"
              title="Refresh tools"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${fetchingTools ? "animate-spin" : ""}`}
              />
            </Button>
            {onClose && (
              <Button
                onClick={onClose}
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Hide sidebar"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {/* Run button */}
          <Button
            onClick={handleExecute}
            disabled={loading || !canExecute}
            size="sm"
            className="h-8 px-3 text-xs ml-auto"
          >
            {loading ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            <span className="ml-1">
              {loading ? (waitingOnElicitation ? "Waiting" : "Running") : "Run"}
            </span>
          </Button>
        </div>
      </div>

      {/* Content area */}
      {selectedToolName && formFields && onFieldChange ? (
        // Parameters view when tool is selected
        <div className="flex-1 flex flex-col min-h-0">
          <SelectedToolHeader
            toolName={selectedToolName}
            description={selectedTool?.description}
            onExpand={() => onSelectTool("")}
            onClear={() => onSelectTool("")}
          />

          <ScrollArea className="flex-1">
            <ParametersForm
              fields={formFields}
              onFieldChange={onFieldChange}
              onToggleField={onToggleField ?? (() => {})}
              onExecute={onExecute}
            />

            {/* Task execution options */}
            {serverSupportsTaskToolCalls && (
              <div className="px-3 py-3 border-t border-border">
                {taskRequired ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                      <Clock className="h-3 w-3" />
                      <span>Task required</span>
                    </span>
                    {onTaskTtlChange && (
                      <div className="flex items-center gap-1 ml-auto">
                        <Input
                          type="number"
                          min={0}
                          defaultValue={taskTtl ?? 0}
                          onBlur={(e) =>
                            onTaskTtlChange(parseInt(e.target.value) || 0)
                          }
                          className="w-16 h-6 text-[10px] px-1.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          title="TTL in milliseconds"
                        />
                        <span className="text-[10px] text-muted-foreground">
                          ms
                        </span>
                      </div>
                    )}
                  </div>
                ) : onExecuteAsTaskChange ? (
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                      <input
                        type="checkbox"
                        checked={executeAsTask ?? false}
                        onChange={(e) =>
                          onExecuteAsTaskChange(e.target.checked)
                        }
                        className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer"
                      />
                      <Clock className="h-3 w-3" />
                      <span>Execute as task</span>
                    </label>
                    {executeAsTask && onTaskTtlChange && (
                      <div className="flex items-center gap-1 ml-auto">
                        <Input
                          type="number"
                          min={0}
                          defaultValue={taskTtl ?? 0}
                          onBlur={(e) =>
                            onTaskTtlChange(parseInt(e.target.value) || 0)
                          }
                          className="w-16 h-6 text-[10px] px-1.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          title="TTL in milliseconds"
                        />
                        <span className="text-[10px] text-muted-foreground">
                          ms
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </ScrollArea>
        </div>
      ) : (
        // Tool list or saved requests view
        <div className="flex-1 flex flex-col min-h-0">
          {/* Search */}
          <div className="px-3 py-2 flex-shrink-0">
            <SearchInput
              value={searchQuery}
              onValueChange={onSearchQueryChange}
              placeholder={
                activeTab === "tools"
                  ? "Search tools..."
                  : "Search saved requests..."
              }
            />
          </div>

          {/* List content */}
          <div className="flex-1 overflow-hidden">
            {activeTab === "tools" ? (
              <ScrollArea className="h-full">
                <div className="p-2 pb-16">
                  {fetchingTools && !cursor ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                        <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
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
                    <>
                      <div className="grid grid-cols-1 gap-2">
                        {filteredToolNames
                          .slice(0, displayedToolCount)
                          .map((name) => (
                            <ToolItem
                              key={name}
                              tool={tools[name]}
                              name={name}
                              isSelected={selectedToolName === name}
                              onClick={() => onSelectTool(name)}
                            />
                          ))}
                      </div>

                      {/* Sentinel observed by IntersectionObserver */}
                      <div ref={sentinelRef} className="h-4" />

                      {loadingMore && (
                        <div className="flex items-center justify-center py-3 text-xs text-muted-foreground gap-2">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          <span>Loading more tools…</span>
                        </div>
                      )}

                      {!cursor &&
                        filteredToolNames.length > 0 &&
                        !loadingMore && (
                          <div className="text-center py-3 text-xs text-muted-foreground">
                            No more tools
                          </div>
                        )}
                    </>
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
      )}
    </div>
  );
}
