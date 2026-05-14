/**
 * MultiServerToolsPaneInner
 *
 * Aggregates tools across an active set of servers and renders them as a
 * single flat list — visually identical to the single-server `PlaygroundLeft`
 * (TabHeader + ToolList + SelectedToolHeader + accordion). The only
 * multi-server difference is a small server badge that appears on tools
 * whose names collide across servers.
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mcpjam/design-system/tooltip";
import { RefreshCw } from "lucide-react";
import { useAggregatedTools } from "@/hooks/use-aggregated-tools";
import { useAppBuilderStateContext } from "@/components/ui-playground/hooks/use-app-builder-state";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import { TabHeader } from "@/components/ui-playground/TabHeader";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { SearchInput } from "@/components/ui/search-input";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import { cn } from "@/lib/utils";

interface InnerProps {
  activeServerNames: string[];
}

interface Selection {
  serverId: string;
  toolName: string;
}

export function MultiServerToolsPaneInner({ activeServerNames }: InnerProps) {
  const state = useAppBuilderStateContext();
  const {
    flat,
    collidingNames,
    loadingByServer,
    errorByServer,
    refetch,
  } = useAggregatedTools(activeServerNames);

  const [selected, setSelected] = useState<Selection | null>(null);
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [searchQuery, setSearchQuery] = useState("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [isListExpanded, setIsListExpanded] = useState(true);

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

  useEffect(() => {
    if (selectedEntry) {
      setFormFields(generateFormFieldsFromSchema(selectedEntry.tool.inputSchema));
    } else {
      setFormFields([]);
    }
  }, [selectedEntry]);

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
      const haystack =
        `${entry.toolName} ${entry.tool.description ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [flat, searchQuery]);

  const isLoadingAny = Object.values(loadingByServer).some(Boolean);
  const errorMessages = Object.entries(errorByServer)
    .filter(([, msg]) => Boolean(msg))
    .map(([serverId, msg]) => ({ serverId, msg }));

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
    setSelected(entry);
    setIsListExpanded(false);
    setActiveTab("tools");
  };

  const handleTabChange = (tab: "tools" | "saved") => {
    setActiveTab(tab);
    if (tab === "tools" && selected) {
      // Returning to Tools while a selection exists: keep selection but show
      // the parameters view. Mirrors single-server behavior.
      setIsListExpanded(false);
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
    if (!selected || state.isExecuting) return;
    e.preventDefault();
    void handleExecute();
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
        isExecuting={state.isExecuting}
        canExecute={!!selected}
        canSave={false}
        fetchingTools={isLoadingAny}
        onExecute={() => void handleExecute()}
        onSave={() => {}}
        onRefresh={() => void refetch()}
      />

      <div className="flex-1 min-h-0">
        {activeTab === "saved" ? (
          <SavedRequestsPlaceholder />
        ) : isListExpanded || !selectedEntry ? (
          <FlatToolList
            entries={filteredEntries}
            totalCount={flat.length}
            collidingNames={collidingNames}
            loading={isLoadingAny}
            errors={errorMessages}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
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
        ) : (
          <SelectedToolView
            entry={selectedEntry}
            isColliding={collidingNames.includes(selectedEntry.toolName)}
            formFields={formFields}
            onExpand={() => setIsListExpanded(true)}
            onFieldChange={handleFieldChange}
            onToggleField={handleToggleField}
          />
        )}
      </div>
    </div>
  );
}

interface FlatToolListProps {
  entries: ReturnType<typeof useAggregatedTools>["flat"];
  totalCount: number;
  collidingNames: string[];
  loading: boolean;
  errors: Array<{ serverId: string; msg: string }>;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  selected: Selection | null;
  onToggleSelected: (entry: Selection) => void;
}

function FlatToolList({
  entries,
  totalCount,
  collidingNames,
  loading,
  errors,
  searchQuery,
  onSearchQueryChange,
  selected,
  onToggleSelected,
}: FlatToolListProps) {
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
        {errors.length > 0 ? (
          <div className="mx-1 mb-2 space-y-1">
            {errors.map(({ serverId, msg }) => (
              <div
                key={serverId}
                className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
              >
                <span className="font-medium">{serverId}:</span> {msg}
              </div>
            ))}
          </div>
        ) : null}

        {loading && entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
            <p className="text-xs text-muted-foreground">Loading tools...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-8 px-4">
            <p className="text-xs text-muted-foreground">
              {totalCount === 0
                ? "No tools found. Try refreshing and make sure the servers are running."
                : "No tools match your search"}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {entries.map((entry) => {
              const isSelected =
                selected?.serverId === entry.serverId &&
                selected?.toolName === entry.toolName;
              const isColliding = collidingNames.includes(entry.toolName);
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
                    {isColliding ? (
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
                  {uiType ? (
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
                  ) : null}
                </button>
              );
            })}
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
        <Accordion
          type="multiple"
          value={openSections}
          onValueChange={setOpenSections}
          className="px-3"
        >
          {entry.tool.description && (
            <AccordionItem value="description">
              <AccordionTrigger className="text-xs">
                Description
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {entry.tool.description}
                </p>
              </AccordionContent>
            </AccordionItem>
          )}
          {entry.tool.inputSchema && (
            <AccordionItem value="input-schema">
              <AccordionTrigger className="text-xs">
                Input Schema
              </AccordionTrigger>
              <AccordionContent>
                <SchemaViewer schema={entry.tool.inputSchema} />
              </AccordionContent>
            </AccordionItem>
          )}
          {entry.tool.outputSchema && (
            <AccordionItem value="output-schema">
              <AccordionTrigger className="text-xs">
                Output Schema
              </AccordionTrigger>
              <AccordionContent>
                <SchemaViewer schema={entry.tool.outputSchema} />
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

function SavedRequestsPlaceholder() {
  return (
    <div className="h-full flex items-center justify-center px-4">
      <p className="text-center text-xs text-muted-foreground">
        Saved requests aren't supported in multi-server mode yet.
      </p>
    </div>
  );
}
