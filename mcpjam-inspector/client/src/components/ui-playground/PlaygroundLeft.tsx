/**
 * PlaygroundLeft
 *
 * Left panel of the UI Playground with:
 * - Collapsible tool list (collapses when tool is selected)
 * - Dynamic parameters form
 * - Device/display mode controls at bottom
 */

import { useState, useEffect, useMemo } from "react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@mcpjam/design-system/accordion";
import type { Tool } from "@modelcontextprotocol/client";
import { useAppToolsRegistry } from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { SearchInput } from "../ui/search-input";
import { SavedRequestItem } from "../tools/SavedRequestItem";
import type { FormField } from "@/lib/tool-form";
import type { SavedRequest } from "@/lib/types/request-types";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
import { LoggerView } from "../logger-view";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "../ui/resizable";

import { TabHeader } from "./TabHeader";
import { ToolList } from "./ToolList";
import { SelectedToolHeader } from "./SelectedToolHeader";
import { ParametersForm } from "./ParametersForm";
import { useBuiltinToolRun } from "@/components/playground/use-builtin-tool-run";
import { BuiltinToolDetailView } from "@/components/playground/BuiltinToolDetailView";

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
  /**
   * Whether to render the inline LoggerView in the bottom resizable slot.
   * Defaults to true for legacy callers. The Playground left rail passes
   * `false` because the logger lives in the right rail.
   */
  showLogger?: boolean;
  /** Harness native built-in tools (display-only). Present for harness hosts. */
  builtinTools?: HarnessBuiltinToolInfo[];
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
  showLogger = true,
  builtinTools = [],
}: PlaygroundLeftProps) {
  const [isListExpanded, setIsListExpanded] = useState(!selectedToolName);
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [searchQuery, setSearchQuery] = useState("");

  // Harness built-in tools flow through the SAME select → detail → Run UX as
  // server tools, but "Run" asks the agent (see useBuiltinToolRun). Only one of
  // {server tool, built-in} is selected at a time.
  const builtin = useBuiltinToolRun(builtinTools);
  const hasSelection = !!selectedToolName || !!builtin.selected;
  const builtinNames = useMemo(
    () => builtinTools.map((t) => t.name),
    [builtinTools],
  );

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

  // Sync list expansion when the selection (server OR built-in) changes. A
  // manual expand (back) doesn't change the selection, so it persists.
  useEffect(() => {
    setIsListExpanded(!selectedToolName && !builtin.selectedKey);
  }, [selectedToolName, builtin.selectedKey]);

  const handleTabChange = (tab: "tools" | "saved") => {
    setActiveTab(tab);
    if (tab === "tools" && hasSelection) {
      onSelectTool(null);
      builtin.clear();
    }
  };

  const handleLoadRequest = (req: SavedRequest) => {
    onLoadRequest(req);
  };

  const handleToolListSelect = (name: string) => {
    builtin.clear();
    onSelectTool(name);
    setIsListExpanded(false);
  };

  const handleSelectBuiltin = (key: string) => {
    onSelectTool(null);
    builtin.select(key);
    setIsListExpanded(false);
  };

  // Top "Run": execute the selected server tool, OR ask the agent to run the
  // selected built-in tool (no API can fire a built-in tool call directly).
  const handleRun = () => {
    if (builtin.selected) builtin.askAgentToRun();
    else onExecute();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName;
    // Avoid firing while typing in multiline fields
    if (tag === "TEXTAREA") return;
    if (!hasSelection || isExecuting) return;
    e.preventDefault();
    handleRun();
  };

  const mainContent = (
    <div className="h-full min-h-0">
      {activeTab === "saved" && !hasSelection ? (
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
      ) : isListExpanded || !hasSelection ? (
        <ToolList
          tools={tools}
          toolNames={toolNames}
          filteredToolNames={filteredToolNames}
          selectedToolName={isListExpanded ? null : selectedToolName}
          fetchingTools={fetchingTools}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSelectTool={handleToolListSelect}
          onCollapseList={() => setIsListExpanded(false)}
          builtinTools={builtinTools}
          selectedBuiltinKey={isListExpanded ? null : builtin.selectedKey}
          onSelectBuiltin={handleSelectBuiltin}
        />
      ) : builtin.selected ? (
        <BuiltinToolDetailView
          tool={builtin.selected}
          fields={builtin.fields}
          onExpand={() => setIsListExpanded(true)}
          onFieldChange={builtin.onFieldChange}
          onToggleField={builtin.onToggleField}
          switchNames={builtinNames}
          onSwitch={(name) => {
            const t = builtinTools.find((x) => x.name === name);
            if (t) handleSelectBuiltin(t.key);
          }}
        />
      ) : (
        <ToolParametersView
          selectedToolName={selectedToolName!}
          selectedTool={tools[selectedToolName!]}
          toolNames={toolNames}
          formFields={formFields}
          onExpand={() => setIsListExpanded(true)}
          onSelectTool={onSelectTool}
          onFieldChange={onFieldChange}
          onToggleField={onToggleField}
        />
      )}
    </div>
  );

  return (
    <div
      className="h-full min-w-0 flex flex-col bg-background overflow-hidden"
      onKeyDownCapture={handleKeyDown}
    >
      {/* Header with tabs and actions */}
      <TabHeader
        activeTab={activeTab}
        onTabChange={handleTabChange}
        toolCount={toolNames.length}
        savedCount={savedRequests.length}
        isExecuting={isExecuting}
        canExecute={hasSelection}
        canSave={!!selectedToolName}
        fetchingTools={fetchingTools}
        onExecute={handleRun}
        onSave={onSave}
        onRefresh={onRefresh}
        onClose={onClose}
      />

      {/* Middle Content Area + Logger */}
      {showLogger ? (
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
      ) : (
        <div className="flex-1 min-h-0">{mainContent}</div>
      )}
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
  selectedTool?: Tool;
  toolNames: string[];
  formFields: FormField[];
  onExpand: () => void;
  onSelectTool: (name: string | null) => void;
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
}

function ToolParametersView({
  selectedToolName,
  selectedTool,
  toolNames,
  formFields,
  onExpand,
  onSelectTool,
  onFieldChange,
  onToggleField,
}: ToolParametersViewProps) {
  // Fall back to the app-tools registry when the selection is an
  // `app_<hash>` alias — the server-tool dict won't have it. Same shape:
  // we only read `description`, `inputSchema`, and `outputSchema` below,
  // and `AppToolDescriptor` carries all three. Routing through the
  // registry's `resolve()` inherits its `activeBridgeByParent` gate so a
  // superseded sibling instance won't render here.
  const appToolDescriptor = useAppToolsRegistry((s) => {
    if (selectedTool) return undefined;
    const resolved = s.resolve(selectedToolName);
    if (!resolved) return undefined;
    return resolved.instance.tools.find((t) => t.name === resolved.rawName);
  });
  const effectiveTool = selectedTool ?? appToolDescriptor;
  // For app-tool aliases (`app_<hash>`), show the raw advertised tool name in
  // the header instead of the opaque alias. Server tools fall back to the
  // selection key, which is already the raw name.
  const headerToolName = appToolDescriptor?.name ?? selectedToolName;
  const hasParameters = formFields && formFields.length > 0;
  const [openSections, setOpenSections] = useState<string[]>(["description"]);

  useEffect(() => {
    setOpenSections(hasParameters ? ["parameters"] : ["description"]);
  }, [selectedToolName, hasParameters]);

  return (
    <div className="h-full flex flex-col">
      <SelectedToolHeader
        toolName={headerToolName}
        onExpand={onExpand}
        toolSwitchList={{
          names: toolNames,
          onSelect: (name) => onSelectTool(name),
        }}
      />
      <ScrollArea className="flex-1 min-h-0">
        <Accordion
          type="multiple"
          value={openSections}
          onValueChange={setOpenSections}
          className="px-3"
        >
          {effectiveTool?.description && (
            <AccordionItem value="description">
              <AccordionTrigger className="text-xs">
                Description
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {effectiveTool.description}
                </p>
              </AccordionContent>
            </AccordionItem>
          )}
          {effectiveTool?.inputSchema && (
            <AccordionItem value="input-schema">
              <AccordionTrigger className="text-xs">
                Input Schema
              </AccordionTrigger>
              <AccordionContent>
                <SchemaViewer schema={effectiveTool.inputSchema} />
              </AccordionContent>
            </AccordionItem>
          )}
          {effectiveTool?.outputSchema && (
            <AccordionItem value="output-schema">
              <AccordionTrigger className="text-xs">
                Output Schema
              </AccordionTrigger>
              <AccordionContent>
                <SchemaViewer schema={effectiveTool.outputSchema} />
              </AccordionContent>
            </AccordionItem>
          )}
          {hasParameters && (
            <AccordionItem value="parameters">
              <AccordionTrigger className="text-xs">
                Parameters
              </AccordionTrigger>
              <AccordionContent>
                <ParametersForm
                  fields={formFields}
                  onFieldChange={onFieldChange}
                  onToggleField={onToggleField}
                />
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </ScrollArea>
    </div>
  );
}
