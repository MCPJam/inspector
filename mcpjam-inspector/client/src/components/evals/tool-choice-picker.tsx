import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Check, ChevronsUpDown, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { cn } from "@/lib/utils";
import {
  getSpecificToolChoiceName,
  getToolChoiceLabel,
  normalizeToolChoice,
  type EvalToolChoice,
} from "@/shared/tool-choice";

type AvailableTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;
};

type ToolChoicePickerProps = {
  value?: unknown;
  onChange: (value: EvalToolChoice | undefined) => void;
  availableTools?: AvailableTool[];
  className?: string;
};

type PickerModeItem = {
  kind: "mode";
  key: string;
  label: string;
  description: string;
  value: EvalToolChoice;
};

type PickerToolItem = {
  kind: "tool";
  key: string;
  tool: AvailableTool;
  value: EvalToolChoice;
};

const MODE_ITEMS: PickerModeItem[] = [
  {
    kind: "mode",
    key: "mode:auto",
    label: "Automatic",
    description: "Let the model decide whether to call a tool.",
    value: "auto",
  },
  {
    kind: "mode",
    key: "mode:required",
    label: "Required",
    description: "Force at least one tool call, but let the model choose which tool.",
    value: "required",
  },
  {
    kind: "mode",
    key: "mode:none",
    label: "No tools",
    description: "Disable tool calls for this case.",
    value: "none",
  },
];

function getChoiceKey(value: unknown): string {
  const normalized = normalizeToolChoice(value);

  if (!normalized) {
    return "mode:auto";
  }

  return typeof normalized === "string"
    ? `mode:${normalized}`
    : `tool:${normalized.toolName}`;
}

function getItemDescription(item: PickerModeItem | PickerToolItem): string {
  if (item.kind === "mode") {
    return item.description;
  }

  return item.tool.description?.trim() || "No description available.";
}

function isToolInputSchemaObject(schema: unknown): schema is {
  properties?: Record<string, any>;
  required?: string[];
} {
  return Boolean(schema) && typeof schema === "object";
}

export function ToolChoicePicker({
  value,
  onChange,
  availableTools = [],
  className,
}: ToolChoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeKey, setActiveKey] = useState(getChoiceKey(value));

  const sortedTools = useMemo(
    () => [...availableTools].sort((a, b) => a.name.localeCompare(b.name)),
    [availableTools],
  );

  const filteredModeItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return MODE_ITEMS;
    }

    return MODE_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query),
    );
  }, [search]);

  const filteredToolItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const tools = !query
      ? sortedTools
      : sortedTools.filter((tool) => {
          const haystack = [
            tool.name,
            tool.description ?? "",
            tool.serverId ?? "",
            JSON.stringify(tool.inputSchema ?? {}),
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        });

    return tools.map<PickerToolItem>((tool) => ({
      kind: "tool",
      key: `tool:${tool.name}`,
      tool,
      value: { type: "tool", toolName: tool.name },
    }));
  }, [search, sortedTools]);

  const allItems = useMemo(
    () => [...filteredModeItems, ...filteredToolItems],
    [filteredModeItems, filteredToolItems],
  );

  const currentToolName = getSpecificToolChoiceName(value);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setActiveKey(getChoiceKey(value));
    }
  }, [open, value]);

  useEffect(() => {
    if (allItems.length === 0) {
      return;
    }

    const hasActiveItem = allItems.some((item) => item.key === activeKey);
    if (!hasActiveItem) {
      setActiveKey(allItems[0]!.key);
    }
  }, [activeKey, allItems]);

  const activeItem = allItems.find((item) => item.key === activeKey) ?? null;

  const activeTool =
    activeItem?.kind === "tool"
      ? activeItem.tool
      : currentToolName
        ? sortedTools.find((tool) => tool.name === currentToolName) ?? null
        : null;

  const selectedKey = getChoiceKey(value);

  const renderToolDetails = (tool: AvailableTool) => {
    const schema = isToolInputSchemaObject(tool.inputSchema)
      ? tool.inputSchema
      : null;
    const properties = schema?.properties
      ? Object.entries(schema.properties)
      : [];
    const required = new Set(schema?.required ?? []);

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-mono text-sm text-foreground">{tool.name}</div>
            {tool.serverId ? (
              <Badge variant="secondary" className="font-normal">
                {tool.serverId}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {tool.description?.trim() ||
              "This tool does not include a description."}
          </p>
          <p className="text-[11px] leading-5 text-muted-foreground">
            Choosing a specific tool constrains the model to this tool only. It
            does not prefill or lock tool arguments.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Params
          </div>
          {properties.length > 0 ? (
            <div className="space-y-2">
              {properties.map(([name, property]) => (
                <div
                  key={name}
                  className="rounded-md border border-border/60 bg-muted/20 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-foreground">
                      {name}
                    </span>
                    {required.has(name) ? (
                      <Badge variant="default" className="h-5 text-[10px]">
                        required
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="h-5 text-[10px]">
                        optional
                      </Badge>
                    )}
                    {property?.type ? (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        {String(property.type)}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {typeof property?.description === "string" &&
                    property.description.trim()
                      ? property.description
                      : "No parameter description provided."}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
              No top-level input parameters were published for this tool.
            </div>
          )}
        </div>

        {tool.inputSchema ? (
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Full Schema
            </div>
            <SchemaViewer schema={tool.inputSchema} />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Tool choice"
          className={cn(
            "mt-1.5 w-full justify-between border-border/70 bg-background px-3 text-left font-normal",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {getToolChoiceLabel(value) || "Automatic"}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(44rem,calc(100vw-2rem))] p-0"
      >
        <div className="grid min-h-[24rem] grid-cols-1 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <div className="border-b border-border/60 md:border-r md:border-b-0">
            <div className="border-b border-border/60 p-3">
              <Input
                value={search}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setSearch(event.target.value)
                }
                placeholder="Search modes or tools..."
                aria-label="Search tool choices"
              />
            </div>
            <ScrollArea className="h-[20rem]">
              <div className="space-y-4 p-2">
                <div className="space-y-1">
                  <div className="px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Modes
                  </div>
                  {filteredModeItems.map((item) => {
                    const isSelected = selectedKey === item.key;
                    const isActive = activeKey === item.key;

                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          setActiveKey(item.key);
                          onChange(item.value);
                        }}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-muted/50",
                        )}
                      >
                        <Check
                          className={cn(
                            "mt-0.5 h-4 w-4 shrink-0",
                            isSelected ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <div className="min-w-0">
                          <div className="text-sm">{item.label}</div>
                          <div className="text-xs leading-5 text-muted-foreground">
                            {item.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-1">
                  <div className="px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Tools
                    <span className="ml-2 text-[10px] normal-case tracking-normal">
                      {sortedTools.length}
                    </span>
                  </div>
                  {filteredToolItems.length > 0 ? (
                    filteredToolItems.map((item) => {
                      const isSelected = selectedKey === item.key;
                      const isActive = activeKey === item.key;

                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => {
                            setActiveKey(item.key);
                            onChange(item.value);
                          }}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
                            isActive
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted/50",
                          )}
                        >
                          <Check
                            className={cn(
                              "mt-0.5 h-4 w-4 shrink-0",
                              isSelected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="min-w-0">
                            <div className="font-mono text-sm">{item.tool.name}</div>
                            <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                              {getItemDescription(item)}
                            </div>
                            {item.tool.serverId ? (
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                {item.tool.serverId}
                              </div>
                            ) : null}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-2 py-3 text-xs text-muted-foreground">
                      No tools matched your search.
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>

          <div className="p-4">
            {activeItem ? (
              activeItem.kind === "mode" ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-foreground">
                      {activeItem.label}
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {activeItem.description}
                    </p>
                  </div>
                  <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-xs leading-5 text-muted-foreground">
                    Select a mode when you want broad behavior control. Select a
                    specific tool from the list when you want the model to stay on
                    one tool and you need to inspect its parameter schema first.
                  </div>
                </div>
              ) : (
                renderToolDetails(activeItem.tool)
              )
            ) : activeTool ? (
              renderToolDetails(activeTool)
            ) : (
              <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                Choose a mode or a tool to inspect its configuration.
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
