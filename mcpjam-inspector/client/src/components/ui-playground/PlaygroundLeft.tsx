/**
 * PlaygroundLeft
 *
 * Left panel of the UI Playground with:
 * - Collapsible tool list (collapses when tool is selected)
 * - Dynamic parameters form
 * - Device/display mode controls at bottom
 */

import { useState, useEffect, useMemo } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ScrollArea } from "../ui/scroll-area";
import { SearchInput } from "../ui/search-input";
import { SavedRequestItem } from "../tools/SavedRequestItem";
import type { FormField } from "@/lib/tool-form";
import type { SavedRequest } from "@/lib/types/request-types";
import { LoggerView } from "../logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "../ui/resizable";

import { TabHeader } from "./TabHeader";
import { ToolList } from "./ToolList";
import { SelectedToolHeader } from "./SelectedToolHeader";
import { ParametersForm } from "./ParametersForm";
import { detectUiTypeFromTool, UIType } from "@/lib/mcp-ui/mcp-apps-utils";

interface PlaygroundLeftProps {
  tools: Record<string, Tool>;
  selectedToolName: string | null;
  fetchingTools: boolean;
  onRefresh: () => void;
  onSelectTool: (name: string | null) => void;
  formFields: FormField[];
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
  isExecuting: boolean;
  onExecute: () => void;
  onSave: () => void;
  // Saved requests
  savedRequests: SavedRequest[];
  highlightedRequestId: string | null;
  onLoadRequest: (req: SavedRequest) => void;
  onRenameRequest: (req: SavedRequest) => void;
  onDuplicateRequest: (req: SavedRequest) => void;
  onDeleteRequest: (id: string) => void;
  // Panel visibility
  onClose?: () => void;
}

export function PlaygroundLeft({
  tools,
  selectedToolName,
  fetchingTools,
  onRefresh,
  onSelectTool,
  formFields,
  onFieldChange,
  onToggleField,
  isExecuting,
  onExecute,
  onSave,
  savedRequests,
  highlightedRequestId,
  onLoadRequest,
  onRenameRequest,
  onDuplicateRequest,
  onDeleteRequest,
  onClose,
}: PlaygroundLeftProps) {
  const [isListExpanded, setIsListExpanded] = useState(!selectedToolName);
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [searchQuery, setSearchQuery] = useState("");

  // Get all tool names
  const toolNames = useMemo(() => {
    return Object.keys(tools);
  }, [tools]);

  // Filter tool names by search query (no UI filtering - show all tools)
  const filteredToolNames = useMemo(() => {
    if (!searchQuery.trim()) return toolNames;
    const query = searchQuery.trim().toLowerCase();
    return toolNames.filter((name) => {
      const tool = tools[name];
      const haystack = `${name} ${tool?.description ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [toolNames, tools, searchQuery]);

  // Filter saved requests by search query
  const filteredSavedRequestsLocal = useMemo(() => {
    if (!searchQuery.trim()) return savedRequests;
    const query = searchQuery.trim().toLowerCase();
    return savedRequests.filter((req) => {
      const haystack =
        `${req.title} ${req.description ?? ""} ${req.toolName}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [savedRequests, searchQuery]);

  // Sync list expansion with tool selection
  useEffect(() => {
    setIsListExpanded(!selectedToolName);
  }, [selectedToolName]);

  const handleTabChange = (tab: "tools" | "saved") => {
    setActiveTab(tab);
    if (tab === "tools" && selectedToolName) {
      onSelectTool(null);
    }
  };

  const handleLoadRequest = (req: SavedRequest) => {
    onLoadRequest(req);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName;
    // Avoid firing while typing in multiline fields
    if (tag === "TEXTAREA") return;
    if (!selectedToolName || isExecuting) return;
    e.preventDefault();
    onExecute();
  };

  const shouldRenderUiTypeOverrideSelector = useMemo(() => {
    if (!selectedToolName) return false;
    return (
      detectUiTypeFromTool(tools[selectedToolName!]) ===
      UIType.OPENAI_SDK_AND_MCP_APPS
    );
  }, [selectedToolName, tools]);

  const mainContent = (
    <div className="h-full min-h-0">
      {activeTab === "saved" && !selectedToolName ? (
        <SavedRequestsTab
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          savedRequests={savedRequests}
          filteredSavedRequests={filteredSavedRequestsLocal}
          highlightedRequestId={highlightedRequestId}
          onLoadRequest={handleLoadRequest}
          onRenameRequest={onRenameRequest}
          onDuplicateRequest={onDuplicateRequest}
          onDeleteRequest={onDeleteRequest}
        />
      ) : isListExpanded ? (
        <ToolList
          tools={tools}
          toolNames={toolNames}
          filteredToolNames={filteredToolNames}
          selectedToolName={selectedToolName}
          fetchingTools={fetchingTools}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSelectTool={onSelectTool}
          onCollapseList={() => setIsListExpanded(false)}
        />
      ) : (
        <ToolParametersView
          selectedToolName={selectedToolName!}
          formFields={formFields}
          onExpand={() => setIsListExpanded(true)}
          onClear={() => onSelectTool(null)}
          onFieldChange={onFieldChange}
          onToggleField={onToggleField}
          shouldRenderUiTypeOverrideSelector={
            shouldRenderUiTypeOverrideSelector
          }
        />
      )}
    </div>
  );

  return (
    <div
      className="h-full flex flex-col border-r border-border bg-background overflow-hidden"
      onKeyDownCapture={handleKeyDown}
    >
      {/* Header with tabs and actions */}
      <TabHeader
        activeTab={activeTab}
        onTabChange={handleTabChange}
        toolCount={toolNames.length}
        savedCount={savedRequests.length}
        isExecuting={isExecuting}
        canExecute={!!selectedToolName}
        canSave={!!selectedToolName}
        fetchingTools={fetchingTools}
        onExecute={onExecute}
        onSave={onSave}
        onRefresh={onRefresh}
        onClose={onClose}
      />

      {/* Middle Content Area + Logger */}
      <ResizablePanelGroup
        direction="vertical"
        className="flex-1 min-h-0"
        autoSaveId="ui-playground-left-logger"
      >
        <ResizablePanel defaultSize={65} minSize={10}>
          {mainContent}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={35} minSize={10} maxSize={70}>
          <div className="h-full min-h-0 flex flex-col border-t border-border bg-background">
            <LoggerView isCollapsable={false} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

// --- Internal sub-components ---

interface SavedRequestsTabProps {
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  savedRequests: SavedRequest[];
  filteredSavedRequests: SavedRequest[];
  highlightedRequestId: string | null;
  onLoadRequest: (req: SavedRequest) => void;
  onRenameRequest: (req: SavedRequest) => void;
  onDuplicateRequest: (req: SavedRequest) => void;
  onDeleteRequest: (id: string) => void;
}

function SavedRequestsTab({
  searchQuery,
  onSearchQueryChange,
  savedRequests,
  filteredSavedRequests,
  highlightedRequestId,
  onLoadRequest,
  onRenameRequest,
  onDuplicateRequest,
  onDeleteRequest,
}: SavedRequestsTabProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 flex-shrink-0">
        <SearchInput
          value={searchQuery}
          onValueChange={onSearchQueryChange}
          placeholder="Search saved requests..."
        />
      </div>

      <ScrollArea className="flex-1">
        <div className="pb-2">
          {filteredSavedRequests.length === 0 ? (
            <div className="text-center py-8 px-4">
              <p className="text-xs text-muted-foreground">
                {savedRequests.length === 0
                  ? "No saved requests yet. Execute a tool and save the request to see it here."
                  : "No saved requests match your search."}
              </p>
            </div>
          ) : (
            filteredSavedRequests.map((request) => (
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
    </div>
  );
}

interface ToolParametersViewProps {
  selectedToolName: string;
  formFields: FormField[];
  onExpand: () => void;
  onClear: () => void;
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
  shouldRenderUiTypeOverrideSelector: boolean;
}

function ToolParametersView({
  selectedToolName,
  formFields,
  onExpand,
  onClear,
  onFieldChange,
  onToggleField,
  shouldRenderUiTypeOverrideSelector,
}: ToolParametersViewProps) {
  return (
    <div className="h-full flex flex-col">
      <SelectedToolHeader
        toolName={selectedToolName}
        onExpand={onExpand}
        onClear={onClear}
        showProtocolSelector={shouldRenderUiTypeOverrideSelector}
      />
      <ScrollArea className="flex-1 min-h-0">
        <ParametersForm
          fields={formFields}
          onFieldChange={onFieldChange}
          onToggleField={onToggleField}
        />
      </ScrollArea>
    </div>
  );
}
