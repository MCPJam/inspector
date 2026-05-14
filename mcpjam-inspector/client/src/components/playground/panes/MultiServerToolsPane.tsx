/**
 * MultiServerToolsPaneInner
 *
 * Aggregates tools across an active set of servers, grouped by server, with
 * a server badge on names that collide across servers (same convention as
 * `tool-choice-picker.tsx:204`).
 *
 * - Clicking a tool sets a local `(serverId, toolName)` tuple — kept local
 *   so this doesn't fight `useUIPlaygroundStore.selectedTool`.
 * - Renders the selected tool's parameters form below the list. Form values
 *   are local to this pane (view payload tracks selection, not values).
 * - Execute calls `state.executeTool({ serverName, toolName, parameters })`,
 *   which routes to the right server and pushes the result into the chat
 *   thread via the same pending-execution slot AppBuilderTab uses.
 *
 * The Playground left rail (`PlaygroundLeftRail`) chooses between this and
 * the single-server `PlaygroundLeft` based on `activeServerNames.length`.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Hammer,
  Loader2,
  Play,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { useAggregatedTools } from "@/hooks/use-aggregated-tools";
import { useAppBuilderStateContext } from "@/components/ui-playground/hooks/use-app-builder-state";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import {
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";

interface InnerProps {
  activeServerNames: string[];
}

export function MultiServerToolsPaneInner({ activeServerNames }: InnerProps) {
  const state = useAppBuilderStateContext();
  const { toolsByServer, flat, collidingNames, loadingByServer, errorByServer } =
    useAggregatedTools(activeServerNames);

  const [selected, setSelected] = useState<{
    serverId: string;
    toolName: string;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [formFields, setFormFields] = useState<FormField[]>([]);

  // Selected tool reference (from the aggregated list).
  const selectedTool = useMemo(() => {
    if (!selected) return null;
    return (
      flat.find(
        (entry) =>
          entry.serverId === selected.serverId &&
          entry.toolName === selected.toolName,
      ) ?? null
    );
  }, [flat, selected]);

  // Regenerate form fields whenever the selection changes.
  useEffect(() => {
    if (selectedTool) {
      setFormFields(generateFormFieldsFromSchema(selectedTool.tool.inputSchema));
    } else {
      setFormFields([]);
    }
  }, [selectedTool]);

  // Clear selection if the user toggles off the server it came from.
  useEffect(() => {
    if (selected && !activeServerNames.includes(selected.serverId)) {
      setSelected(null);
    }
  }, [activeServerNames, selected]);

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
    if (!selected || !selectedTool) return;
    await state.executeTool({
      toolName: selected.toolName,
      formFields,
      serverName: selected.serverId,
    });
  };

  const filteredToolsByServer = useMemo(() => {
    if (!searchQuery.trim()) return toolsByServer;
    const query = searchQuery.trim().toLowerCase();
    const filtered: Record<string, typeof toolsByServer[string]> = {};
    for (const [serverId, tools] of Object.entries(toolsByServer)) {
      const matches = tools.filter((tool) => {
        const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
        return haystack.includes(query);
      });
      if (matches.length > 0) filtered[serverId] = matches;
    }
    return filtered;
  }, [toolsByServer, searchQuery]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b px-2 py-2">
        <SearchInput
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search tools across servers…"
        />
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2">
          {activeServerNames.map((serverId) => {
            const tools = filteredToolsByServer[serverId] ?? [];
            const loading = loadingByServer[serverId];
            const error = errorByServer[serverId];
            return (
              <ServerSection
                key={serverId}
                serverId={serverId}
                tools={tools}
                loading={loading}
                error={error}
                collidingNames={collidingNames}
                selected={selected}
                onSelectTool={(toolName) =>
                  setSelected({ serverId, toolName })
                }
              />
            );
          })}
        </div>
      </ScrollArea>

      {selectedTool ? (
        <div className="flex shrink-0 max-h-[50%] flex-col border-t bg-card/30">
          <div className="flex items-center gap-2 border-b px-2 py-1.5">
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {selected!.serverId}
            </Badge>
            <span className="flex-1 truncate font-mono text-xs">
              {selected!.toolName}
            </span>
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={handleExecute}
              disabled={state.isExecuting}
            >
              {state.isExecuting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              Run
            </Button>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <Accordion
              type="multiple"
              defaultValue={["parameters"]}
              className="px-3"
            >
              {selectedTool.tool.description && (
                <AccordionItem value="description">
                  <AccordionTrigger className="text-xs">
                    Description
                  </AccordionTrigger>
                  <AccordionContent>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {selectedTool.tool.description}
                    </p>
                  </AccordionContent>
                </AccordionItem>
              )}
              {selectedTool.tool.inputSchema && (
                <AccordionItem value="input-schema">
                  <AccordionTrigger className="text-xs">
                    Input Schema
                  </AccordionTrigger>
                  <AccordionContent>
                    <SchemaViewer schema={selectedTool.tool.inputSchema} />
                  </AccordionContent>
                </AccordionItem>
              )}
              {formFields.length > 0 && (
                <AccordionItem value="parameters">
                  <AccordionTrigger className="text-xs">
                    Parameters
                  </AccordionTrigger>
                  <AccordionContent>
                    <ParametersForm
                      fields={formFields}
                      onFieldChange={handleFieldChange}
                      onToggleField={handleToggleField}
                    />
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}

interface ServerSectionProps {
  serverId: string;
  tools: Array<{ name: string; description?: string }>;
  loading?: boolean;
  error?: string;
  collidingNames: string[];
  selected: { serverId: string; toolName: string } | null;
  onSelectTool: (toolName: string) => void;
}

function ServerSection({
  serverId,
  tools,
  loading,
  error,
  collidingNames,
  selected,
  onSelectTool,
}: ServerSectionProps) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs font-medium hover:bg-accent"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Hammer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{serverId}</span>
        {loading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {tools.length}
          </Badge>
        )}
      </button>
      {expanded ? (
        <div className="ml-3 mt-0.5 space-y-0.5">
          {error ? (
            <div className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {error}
            </div>
          ) : null}
          {tools.length === 0 && !loading && !error ? (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              No tools.
            </div>
          ) : null}
          {tools.map((tool) => {
            const isSelected =
              selected?.serverId === serverId &&
              selected?.toolName === tool.name;
            const isColliding = collidingNames.includes(tool.name);
            return (
              <button
                key={tool.name}
                type="button"
                onClick={() => onSelectTool(tool.name)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs",
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
                title={tool.description}
              >
                <span className="flex-1 truncate font-mono text-[11px]">
                  {tool.name}
                </span>
                {isColliding ? (
                  <Badge
                    variant="outline"
                    className="h-4 px-1 text-[9px] uppercase"
                  >
                    {serverId.length > 10
                      ? `${serverId.slice(0, 8)}…`
                      : serverId}
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
