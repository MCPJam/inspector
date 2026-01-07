/**
 * PlaygroundLeft
 *
 * Left panel of the UI Playground with:
 * - Collapsible tool list (collapses when tool is selected)
 * - Dynamic parameters form
 * - Device/display mode controls at bottom
 */

import { useState, useEffect } from "react";
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

interface PlaygroundLeftProps {
  tools: Record<string, Tool>;
  toolNames: string[];
  filteredToolNames: string[];
  selectedToolName: string | null;
  fetchingTools: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
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
  filteredSavedRequests: SavedRequest[];
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
  toolNames,
  filteredToolNames,
  selectedToolName,
  fetchingTools,
  searchQuery,
  onSearchQueryChange,
  onRefresh,
  onSelectTool,
  formFields,
  onFieldChange,
  onToggleField,
  isExecuting,
  onExecute,
  onSave,
  savedRequests,
  filteredSavedRequests,
  highlightedRequestId,
  onLoadRequest,
  onRenameRequest,
  onDuplicateRequest,
  onDeleteRequest,
  onClose,
}: PlaygroundLeftProps) {
  console.log("tools", tools);
  const [isListExpanded, setIsListExpanded] = useState(!selectedToolName);
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");

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

  const mainContent = (
    <div className="h-full min-h-0">
      {activeTab === "saved" && !selectedToolName ? (
        <SavedRequestsTab
          searchQuery={searchQuery}
          onSearchQueryChange={onSearchQueryChange}
          savedRequests={savedRequests}
          filteredSavedRequests={filteredSavedRequests}
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
          onSearchQueryChange={onSearchQueryChange}
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
            <LoggerView
              isCollapsable={false}
              isLogLevelVisible={false}
              isSearchVisible={false}
            />
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
}

function ToolParametersView({
  selectedToolName,
  formFields,
  onExpand,
  onClear,
  onFieldChange,
  onToggleField,
}: ToolParametersViewProps) {
  return (
    <div className="h-full flex flex-col">
      <SelectedToolHeader
        toolName={selectedToolName}
        onExpand={onExpand}
        onClear={onClear}
      />

      <div className="flex-1 min-h-0 overflow-auto px-3 py-3">
        <ParametersForm
          fields={formFields}
          onFieldChange={onFieldChange}
          onToggleField={onToggleField}
        />
      </div>
    </div>
  );
}
