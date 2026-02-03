import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Wrench, RefreshCw, Play, Clock, PanelLeftClose } from "lucide-react";
import type { RefObject } from "react";
import { Badge } from "../ui/badge";
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
import { TruncatedText } from "../ui/truncated-text";

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

  // When a tool is selected and we have form props, show the parameters view
  if (selectedToolName && formFields && onFieldChange && onExecute) {
    return (
      <div className="h-full flex flex-col border-r border-border bg-background">
        <SelectedToolHeader
          toolName={selectedToolName}
          onExpand={() => onSelectTool("")}
          onClear={() => onSelectTool("")}
          onSave={onSave ? () => {
            posthog.capture("save_tool_button_clicked", {
              location: "tools_sidebar",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            onSave();
          } : undefined}
        />

        {selectedTool?.description && (
          <div className="px-3 py-3 bg-muted/50 border-b border-border">
            <TruncatedText
              text={selectedTool.description}
              title={selectedToolName}
              maxLength={200}
            />
          </div>
        )}

        <ScrollArea className="flex-1">
          <ParametersForm
            fields={formFields}
            onFieldChange={onFieldChange}
            onToggleField={onToggleField ?? (() => {})}
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
                      onChange={(e) => onExecuteAsTaskChange(e.target.checked)}
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

        {/* Action button */}
        <div className="px-3 py-3 border-t border-border">
          <Button
            onClick={() => {
              posthog.capture("execute_tool", {
                location: "tools_sidebar",
                platform: detectPlatform(),
                environment: detectEnvironment(),
                as_task: executeAsTask ?? false,
              });
              onExecute();
            }}
            disabled={loading}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            size="sm"
          >
            {loading ? (
              <>
                <RefreshCw className="h-3 w-3 animate-spin" />
                {waitingOnElicitation ? "Waiting..." : "Running"}
              </>
            ) : (
              <>
                <Play className="h-3 w-3" />
                Execute
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col border-r border-border bg-background">
      <div className="border-b border-border flex-shrink-0">
        <div className="flex">
          <button
            onClick={() => onChangeTab("tools")}
            className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === "tools"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Tools
          </button>
          <button
            onClick={() => onChangeTab("saved")}
            className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
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
          <div className="flex items-center gap-1">
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
            {onClose && (
              <Button
                onClick={onClose}
                variant="ghost"
                size="sm"
                title="Collapse sidebar"
              >
                <PanelLeftClose className="h-3 w-3" />
              </Button>
            )}
          </div>
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
              {fetchingTools && !cursor ? (
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
  );
}
