/**
 * MultiServerToolsPaneInner
 *
 * Aggregates tools across an active set of servers and renders them as a
 * single flat list — visually identical to the single-server `PlaygroundLeft`
 * (TabHeader + ToolList + SelectedToolHeader + accordion). Origins are
 * grouped: WebMCP, Browser, Servers, then Built-in. A server badge
 * appears on every server row when more than one server is in the list.
 *
 * Selection is a `(serverId, toolName)` tuple kept local to this pane so it
 * doesn't fight `useUIPlaygroundStore.selectedTool` (which is single-string).
 * Execution routes through `state.executeTool({ serverName, toolName, … })`.
 *
 * Saved requests are intentionally not supported here yet — single-server
 * `useSavedRequests` is keyed by one `serverKey` and doesn't generalize.
 * The Saved tab renders an empty state pointing this out.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { RefreshCw } from "lucide-react";
import { useAggregatedTools } from "@/hooks/use-aggregated-tools";
import { usePlaygroundStateContext } from "@/components/ui-playground/hooks/use-playground-state";
import { useSharedAppState } from "@/state/app-state-context";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import { TabHeader } from "@/components/ui-playground/TabHeader";
import { ToolDetailsAccordion } from "@/components/ui/tool-details-accordion";
import { SearchInput } from "@/components/ui/search-input";
import { HarnessBuiltinToolsSection } from "@/components/playground/HarnessBuiltinToolsSection";
import { BrowserToolsSection } from "@/components/playground/BrowserToolsSection";
import { ToolSourceHeader } from "@/components/playground/ToolSourceHeader";
import type { BrowserToolsState } from "@/hooks/useBrowserTools";
import { useBuiltinToolRun } from "@/components/playground/use-builtin-tool-run";
import { useBrowserToolRun } from "@/components/playground/use-browser-tool-run";
import { BuiltinToolDetailView } from "@/components/playground/BuiltinToolDetailView";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
import {
  detectUIType,
  getToolVisibility,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { generateFormFieldsFromSchema, type FormField } from "@/lib/tool-form";
import { cn } from "@/lib/utils";

interface InnerProps {
  activeServerNames: string[];
  /** Harness native built-in tools (display-only). Present for harness hosts. */
  builtinTools?: HarnessBuiltinToolInfo[];
  /** True when the previewed host runs its harness on THIS machine. */
  builtinToolsRunLocally?: boolean;
  /**
   * The agent browser's tools, when the previewed host attaches one. Omitted
   * by callers that don't resolve a host (the Evals embedded chat), which just
   * means the section isn't rendered.
   */
  browserTools?: BrowserToolsState;
}

interface Selection {
  serverId: string;
  toolName: string;
}

export function MultiServerToolsPaneInner({
  activeServerNames,
  builtinTools = [],
  builtinToolsRunLocally = false,
  browserTools,
}: InnerProps) {
  const state = usePlaygroundStateContext();
  const appState = useSharedAppState();
  const reconnectingServerNames = useMemo(
    () =>
      activeServerNames.filter(
        (name) => appState.servers[name]?.connectionStatus === "connecting",
      ),
    [activeServerNames, appState.servers],
  );
  const { flat, collidingNames, loadingByServer, refetch } = useAggregatedTools(
    activeServerNames,
    {
      unavailableServerNames: reconnectingServerNames,
    },
  );

  const [selected, setSelected] = useState<Selection | null>(null);
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [searchQuery, setSearchQuery] = useState("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [isListExpanded, setIsListExpanded] = useState(true);

  // Harness built-in tools share the same select → detail → Run UX; "Run" asks
  // the agent (no API fires a built-in tool call directly). One of {server tool,
  // built-in} is selected at a time.
  const builtin = useBuiltinToolRun(builtinTools);
  const browser = useBrowserToolRun(
    browserTools?.tools ?? [],
    browserTools?.page ?? null,
    browserTools?.invokePage,
  );
  const builtinNames = useMemo(
    () => builtinTools.map((t) => t.name),
    [builtinTools],
  );

  const selectedEntry = useMemo(() => {
    if (!selected) return null;
    return (
      flat.find(
        (entry) =>
          entry.serverId === selected.serverId &&
          entry.toolName === selected.toolName,
      ) ?? null
    );
  }, [flat, selected]);

  // Regenerate fields only when the user picks a different tool — not when
  // `selectedEntry`'s object reference changes from a refetch. Otherwise
  // hitting Refresh (or any background refetch) would blow away a
  // partially-filled parameter form.
  useEffect(() => {
    if (!selected) {
      setFormFields([]);
      return;
    }
    const entry = flat.find(
      (e) =>
        e.serverId === selected.serverId && e.toolName === selected.toolName,
    );
    if (entry) {
      setFormFields(generateFormFieldsFromSchema(entry.tool.inputSchema));
    }
    // Intentionally not depending on `flat` — refetches shouldn't reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.serverId, selected?.toolName]);

  // Drop the selection if the user toggles off its server.
  useEffect(() => {
    if (selected && !activeServerNames.includes(selected.serverId)) {
      setSelected(null);
      setIsListExpanded(true);
    }
  }, [activeServerNames, selected]);

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return flat;
    const query = searchQuery.trim().toLowerCase();
    return flat.filter((entry) => {
      const haystack = `${entry.toolName} ${
        entry.tool.description ?? ""
      }`.toLowerCase();
      return haystack.includes(query);
    });
  }, [flat, searchQuery]);

  const isLoadingAny = Object.values(loadingByServer).some(Boolean);

  const handleFieldChange = (name: string, value: unknown) => {
    setFormFields((current) =>
      current.map((field) =>
        field.name === name ? { ...field, value, isSet: true } : field,
      ),
    );
  };
  const handleToggleField = (name: string, isSet: boolean) => {
    setFormFields((current) =>
      current.map((field) =>
        field.name === name ? { ...field, isSet } : field,
      ),
    );
  };

  const handleExecute = async () => {
    if (!selected || !selectedEntry) return;
    await state.executeTool({
      toolName: selected.toolName,
      formFields,
      serverName: selected.serverId,
    });
  };

  const handleSelect = (entry: Selection) => {
    builtin.clear();
    browser.clear();
    setSelected(entry);
    setIsListExpanded(false);
    setActiveTab("tools");
  };

  const handleSelectBuiltin = (key: string) => {
    setSelected(null);
    browser.clear();
    builtin.select(key);
    setIsListExpanded(false);
    setActiveTab("tools");
  };

  const handleSelectBrowser = (key: string) => {
    setSelected(null);
    builtin.clear();
    browser.select(key);
    setIsListExpanded(false);
    setActiveTab("tools");
  };

  // Top "Run": execute the selected server tool, invoke a page tool directly,
  // or ask the agent to run a built-in / browser verb.
  const handleRun = () => {
    if (browser.selected) void browser.run();
    else if (builtin.selected) builtin.askAgentToRun();
    else void handleExecute();
  };

  const hasSelection =
    !!selectedEntry || !!builtin.selected || !!browser.selected;

  const handleTabChange = (tab: "tools" | "saved") => {
    setActiveTab(tab);
    if (tab === "tools") {
      // Clicking the Tools tab returns to the tool list (the tool menu),
      // deselecting any open tool (server tool or harness built-in) — the
      // same as the back arrow.
      setSelected(null);
      builtin.clear();
      browser.clear();
      setIsListExpanded(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Don't hijack Enter while the user is typing in the search box, a
    // parameter input, or any other editable surface — Enter there means
    // "submit this field" or "newline", not "execute the tool".
    if (
      target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" ||
      target.isContentEditable
    ) {
      return;
    }
    if (!hasSelection || state.isExecuting || browser.invoking) return;
    e.preventDefault();
    handleRun();
  };

  return (
    <div
      className="h-full min-w-0 flex flex-col bg-background overflow-hidden"
      onKeyDownCapture={handleKeyDown}
    >
      <TabHeader
        activeTab={activeTab}
        onTabChange={handleTabChange}
        toolCount={flat.length}
        savedCount={0}
        isExecuting={state.isExecuting || browser.invoking}
        canExecute={browser.selected ? browser.canRun : hasSelection}
        canSave={false}
        fetchingTools={isLoadingAny}
        onExecute={handleRun}
        onSave={() => {}}
        onRefresh={() => void refetch()}
      />

      <div className="flex-1 min-h-0">
        {activeTab === "saved" ? (
          <SavedRequestsPlaceholder />
        ) : isListExpanded || !hasSelection ? (
          <FlatToolList
            entries={filteredEntries}
            totalCount={flat.length}
            loading={isLoadingAny || reconnectingServerNames.length > 0}
            reconnecting={reconnectingServerNames.length > 0}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            builtinTools={builtinTools}
            builtinToolsRunLocally={builtinToolsRunLocally}
            {...(browserTools ? { browserTools } : {})}
            selectedBuiltinKey={isListExpanded ? null : builtin.selectedKey}
            onSelectBuiltin={handleSelectBuiltin}
            selectedBrowserKey={isListExpanded ? null : browser.selectedKey}
            onSelectBrowser={handleSelectBrowser}
            selected={selected}
            onToggleSelected={(entry) => {
              if (
                selected?.serverId === entry.serverId &&
                selected?.toolName === entry.toolName
              ) {
                setIsListExpanded(false);
              } else {
                handleSelect(entry);
              }
            }}
          />
        ) : browser.selected ? (
          <BuiltinToolDetailView
            tool={{
              key: browser.selected.key,
              name: browser.selected.title,
              description: browser.selected.description,
              inputSchema: browser.selected.inputSchema,
            }}
            fields={browser.fields}
            onExpand={() => setIsListExpanded(true)}
            onFieldChange={browser.onFieldChange}
            onToggleField={browser.onToggleField}
            switchItems={browser.catalog.map((tool) => ({
              id: tool.key,
              label: tool.title,
            }))}
            selectedSwitchId={browser.selected.key}
            onSwitch={handleSelectBrowser}
            headerDescription={
              browser.selected.kind === "page"
                ? `${browser.selected.callName}${
                    browser.selected.originHost
                      ? ` · ${browser.selected.originHost}`
                      : ""
                  }`
                : undefined
            }
            runHint={
              browser.selected.blocking
                ? "is disabled — this tool was not offered to the model."
                : browser.selected.kind === "page"
                  ? "calls this page tool now, the same way the WebMCP tab does."
                  : "asks the agent to call this browser tool. It drives the open browser — every call still asks first."
            }
            result={browser.result}
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
          selectedEntry && (
            <SelectedToolView
              entry={selectedEntry}
              isColliding={collidingNames.includes(selectedEntry.toolName)}
              formFields={formFields}
              onExpand={() => setIsListExpanded(true)}
              onFieldChange={handleFieldChange}
              onToggleField={handleToggleField}
            />
          )
        )}
      </div>
    </div>
  );
}

interface FlatToolListProps {
  entries: ReturnType<typeof useAggregatedTools>["flat"];
  totalCount: number;
  loading: boolean;
  reconnecting: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  builtinTools: HarnessBuiltinToolInfo[];
  builtinToolsRunLocally: boolean;
  browserTools?: BrowserToolsState;
  selectedBuiltinKey: string | null;
  onSelectBuiltin: (key: string) => void;
  selectedBrowserKey: string | null;
  onSelectBrowser: (key: string) => void;
  selected: Selection | null;
  onToggleSelected: (entry: Selection) => void;
}

function FlatToolList({
  entries,
  totalCount,
  loading,
  reconnecting,
  searchQuery,
  onSearchQueryChange,
  builtinTools,
  builtinToolsRunLocally,
  browserTools,
  selectedBuiltinKey,
  onSelectBuiltin,
  selectedBrowserKey,
  onSelectBrowser,
  selected,
  onToggleSelected,
}: FlatToolListProps) {
  // A harness host has native built-in tools even with zero MCP-server tools,
  // and a browser host has the six `browser_*` ones — so the "no tools" empty
  // state must account for both, or it reports the wrong reason for a list
  // that is not actually empty.
  const hasBuiltin =
    builtinTools.length > 0 || (browserTools?.tools.length ?? 0) > 0;
  const uniqueServerIds = [...new Set(entries.map((entry) => entry.serverId))];
  const showServerBadge = uniqueServerIds.length > 1;
  const serversChip =
    uniqueServerIds.length === 1
      ? uniqueServerIds[0]
      : uniqueServerIds.length > 1
        ? `${uniqueServerIds.length} servers`
        : undefined;
  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 flex-shrink-0">
        <SearchInput
          value={searchQuery}
          onValueChange={onSearchQueryChange}
          placeholder="Search tools..."
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {loading && entries.length === 0 && !hasBuiltin ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
            <p className="text-xs text-muted-foreground">
              {reconnecting ? "Reconnecting..." : "Loading tools..."}
            </p>
          </div>
        ) : entries.length === 0 && !hasBuiltin ? (
          <div className="text-center py-8 px-4">
            <p className="text-xs text-muted-foreground">
              {totalCount === 0
                ? "No tools found. Try refreshing and make sure the server is running."
                : "No tools match your search"}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {browserTools ? (
              <BrowserToolsSection
                tools={browserTools.tools}
                page={browserTools.page}
                searchQuery={searchQuery}
                selectedKey={selectedBrowserKey}
                onSelect={onSelectBrowser}
              />
            ) : null}
            {entries.length > 0 ? (
              <ToolSourceHeader
                title="Servers"
                chip={serversChip}
                chipTitle={
                  uniqueServerIds.length === 1
                    ? "Every tool under this header comes from this MCP server."
                    : "MCP servers attached to this chat."
                }
              >
                <div className="space-y-0.5">
                  {entries.map((entry) => {
                    const isSelected =
                      selected?.serverId === entry.serverId &&
                      selected?.toolName === entry.toolName;
                    const uiType = detectUIType(entry.tool._meta, undefined);
                    const key = `${entry.serverId}\x00${entry.toolName}`;

                    return (
                      <button
                        key={key}
                        onClick={() =>
                          onToggleSelected({
                            serverId: entry.serverId,
                            toolName: entry.toolName,
                          })
                        }
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1",
                          isSelected
                            ? "cursor-pointer bg-primary/10"
                            : "cursor-pointer hover:bg-muted/50",
                        )}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <code className="text-xs font-mono font-medium truncate flex-1">
                            {entry.toolName}
                          </code>
                          {showServerBadge ? (
                            <Badge
                              variant="outline"
                              className="h-4 shrink-0 px-1 text-[9px] uppercase"
                            >
                              {entry.serverId.length > 10
                                ? `${entry.serverId.slice(0, 8)}…`
                                : entry.serverId}
                            </Badge>
                          ) : null}
                        </div>
                        {entry.tool.description && (
                          <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                            {entry.tool.description}
                          </p>
                        )}
                        {(() => {
                          const visibility = getToolVisibility(
                            entry.tool._meta as
                              | Record<string, unknown>
                              | undefined,
                          );
                          const visibilityLabel = `[${visibility
                            .map((v) => `"${v}"`)
                            .join(", ")}]`;
                          return (
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
                                      {uiType === UIType.MCP_UI
                                        ? "MCP UI"
                                        : "MCP Apps"}
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <span
                                className="font-mono text-[10px] text-muted-foreground"
                                title={`SEP-1865 visibility: ${visibilityLabel}`}
                              >
                                visibility: {visibilityLabel}
                              </span>
                            </div>
                          );
                        })()}
                      </button>
                    );
                  })}
                </div>
              </ToolSourceHeader>
            ) : null}
            <HarnessBuiltinToolsSection
              tools={builtinTools}
              searchQuery={searchQuery}
              selectedKey={selectedBuiltinKey}
              onSelect={onSelectBuiltin}
              localExecution={builtinToolsRunLocally}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface SelectedToolViewProps {
  entry: ReturnType<typeof useAggregatedTools>["flat"][number];
  isColliding: boolean;
  formFields: FormField[];
  onExpand: () => void;
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
}

function SelectedToolView({
  entry,
  isColliding,
  formFields,
  onExpand,
  onFieldChange,
  onToggleField,
}: SelectedToolViewProps) {
  const hasParameters = formFields.length > 0;
  const [openSections, setOpenSections] = useState<string[]>(
    hasParameters ? ["parameters"] : ["description"],
  );

  useEffect(() => {
    setOpenSections(hasParameters ? ["parameters"] : ["description"]);
  }, [entry.serverId, entry.toolName, hasParameters]);

  // Tool name carries an inline server tag in the header when it collides.
  // Single-server SelectedToolHeader shows just the tool name; we keep that
  // visual but prepend a tiny server tag so the user always knows which
  // server will run this.
  const headerToolName = isColliding
    ? `${entry.serverId} · ${entry.toolName}`
    : entry.toolName;

  return (
    <div className="h-full flex flex-col">
      <SelectedToolHeader toolName={headerToolName} onExpand={onExpand} />
      <ScrollArea className="flex-1 min-h-0">
        <ToolDetailsAccordion
          description={entry.tool.description}
          inputSchema={entry.tool.inputSchema}
          outputSchema={entry.tool.outputSchema}
          openSections={openSections}
          onOpenSectionsChange={setOpenSections}
          parameters={
            hasParameters ? (
              <ParametersForm
                fields={formFields}
                onFieldChange={onFieldChange}
                onToggleField={onToggleField}
              />
            ) : undefined
          }
        />
      </ScrollArea>
    </div>
  );
}

function SavedRequestsPlaceholder() {
  return (
    <div className="h-full flex items-center justify-center px-4">
      <p className="text-center text-xs text-muted-foreground">
        Saved requests aren't supported in multi-server mode yet.
      </p>
    </div>
  );
}
