import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

type ToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

type AvailableTool = {
  name: string;
  description?: string;
  inputSchema?: any;
};

type ExpectedToolsEditorProps = {
  toolCalls: ToolCall[];
  onChange: (toolCalls: ToolCall[]) => void;
  availableTools?: AvailableTool[];
};

export function ExpectedToolsEditor({
  toolCalls,
  onChange,
  availableTools = [],
}: ExpectedToolsEditorProps) {
  const [openCombobox, setOpenCombobox] = useState<number | null>(null);
  const [openArgCombobox, setOpenArgCombobox] = useState<string | null>(null);

  const addToolCall = () => {
    onChange([...toolCalls, { toolName: "", arguments: {} }]);
  };

  const removeToolCall = (index: number) => {
    onChange(toolCalls.filter((_, i) => i !== index));
  };

  const updateToolName = (index: number, toolName: string) => {
    const updated = [...toolCalls];

    updated[index] = {
      ...updated[index],
      toolName,
      arguments: {},
    };
    onChange(updated);
  };

  const addArgument = (toolIndex: number, argKey?: string) => {
    const updated = [...toolCalls];
    const existingArgs = updated[toolIndex].arguments || {};

    // If no key provided, generate a temporary one
    let newKey = argKey || "arg";
    if (!argKey) {
      let counter = 1;
      while (existingArgs[newKey] !== undefined) {
        newKey = `arg${counter}`;
        counter++;
      }
    }

    updated[toolIndex] = {
      ...updated[toolIndex],
      arguments: { ...existingArgs, [newKey]: "" },
    };
    onChange(updated);
  };

  const removeArgument = (toolIndex: number, argKey: string) => {
    const updated = [...toolCalls];
    const newArgs = { ...(updated[toolIndex].arguments || {}) };
    delete newArgs[argKey];
    updated[toolIndex] = { ...updated[toolIndex], arguments: newArgs };
    onChange(updated);
  };

  const updateArgumentKey = (
    toolIndex: number,
    oldKey: string,
    newKey: string,
  ) => {
    const updated = [...toolCalls];
    const args = { ...(updated[toolIndex].arguments || {}) };
    if (oldKey !== newKey) {
      const value = args[oldKey];
      delete args[oldKey];
      args[newKey] = value;
    }
    updated[toolIndex] = { ...updated[toolIndex], arguments: args };
    onChange(updated);
  };

  const updateArgumentValue = (
    toolIndex: number,
    argKey: string,
    value: string,
  ) => {
    const updated = [...toolCalls];
    const args = { ...(updated[toolIndex].arguments || {}) };

    // Try to parse as JSON if it looks like a number, boolean, array, or object
    let parsedValue: any = value;
    if (value.trim() !== "") {
      try {
        // Check if it's a number
        if (/^-?\d+\.?\d*$/.test(value)) {
          parsedValue = parseFloat(value);
        }
        // Check if it's a boolean
        else if (value === "true" || value === "false") {
          parsedValue = value === "true";
        }
        // Check if it's JSON (array or object)
        else if (value.startsWith("[") || value.startsWith("{")) {
          parsedValue = JSON.parse(value);
        }
      } catch {
        // If parsing fails, keep as string
        parsedValue = value;
      }
    }

    args[argKey] = parsedValue;
    updated[toolIndex] = { ...updated[toolIndex], arguments: args };
    onChange(updated);
  };

  const getArgumentSchema = (toolIndex: number, argKey: string) => {
    const toolCall = toolCalls[toolIndex];
    const tool = availableTools.find((t) => t.name === toolCall.toolName);
    if (!tool?.inputSchema?.properties) return null;
    return tool.inputSchema.properties[argKey];
  };

  const getAvailableArguments = (toolIndex: number) => {
    const toolCall = toolCalls[toolIndex];
    const tool = availableTools.find((t) => t.name === toolCall.toolName);
    if (!tool?.inputSchema?.properties) return [];

    const properties = tool.inputSchema.properties;
    return Object.keys(properties).map((key) => ({
      key,
      schema: properties[key],
    }));
  };

  return (
    <div className="space-y-4">
      {toolCalls.map((toolCall, toolIndex) => (
        <div
          key={toolIndex}
          className="rounded-md border border-border/40 bg-muted/10 p-4 space-y-3"
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Tool name
              </label>

              {availableTools.length > 0 ? (
                <Popover
                  open={openCombobox === toolIndex}
                  onOpenChange={(open) =>
                    setOpenCombobox(open ? toolIndex : null)
                  }
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={openCombobox === toolIndex}
                      className="w-full justify-between font-mono text-sm h-9"
                    >
                      {toolCall.toolName || "Select tool..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-full max-w-[400px] p-0"
                    align="start"
                  >
                    <Command>
                      <CommandInput
                        placeholder="Search tools..."
                        className="h-8 text-xs"
                      />
                      <CommandEmpty className="text-xs py-2">
                        No tool found.
                      </CommandEmpty>
                      <CommandGroup className="max-h-[200px] overflow-y-auto p-1">
                        {availableTools.map((tool) => (
                          <CommandItem
                            key={tool.name}
                            value={tool.name}
                            onSelect={() => {
                              updateToolName(toolIndex, tool.name);
                              setOpenCombobox(null);
                            }}
                            className="px-2 py-1.5 cursor-pointer"
                          >
                            <div className="flex flex-col flex-1">
                              <span className="font-mono text-xs">
                                {tool.name}
                              </span>
                              {tool.description && (
                                <span className="text-[10px] text-muted-foreground leading-tight">
                                  {tool.description}
                                </span>
                              )}
                            </div>
                            <Check
                              className={cn(
                                "ml-2 h-3 w-3 shrink-0",
                                toolCall.toolName === tool.name
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </Command>
                  </PopoverContent>
                </Popover>
              ) : (
                <Input
                  value={toolCall.toolName}
                  onChange={(e) => updateToolName(toolIndex, e.target.value)}
                  placeholder="e.g. get_transactions"
                  className="font-mono text-sm"
                />
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeToolCall(toolIndex)}
              className="mt-5 h-8 w-8 text-muted-foreground hover:text-destructive"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Arguments
            </label>

            <div className="space-y-2">
              {Object.entries(toolCall.arguments || {}).map(([key, value]) => {
                const argSchema = getArgumentSchema(toolIndex, key);
                return (
                  <div key={key} className="flex items-start gap-2">
                    <div className="flex-1">
                      {argSchema ? (
                        <div>
                          <div className="font-mono text-sm font-medium px-3 py-2 bg-muted/30 rounded-md border border-border/40">
                            {key}
                          </div>
                          {argSchema.description && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {argSchema.description}
                            </p>
                          )}
                        </div>
                      ) : (
                        <Input
                          value={key}
                          onChange={(e) =>
                            updateArgumentKey(toolIndex, key, e.target.value)
                          }
                          placeholder="Key"
                          className="font-mono text-sm"
                        />
                      )}
                    </div>
                    <div className="flex-[2]">
                      <Textarea
                        value={
                          typeof value === "string"
                            ? value
                            : JSON.stringify(value)
                        }
                        onChange={(e) =>
                          updateArgumentValue(toolIndex, key, e.target.value)
                        }
                        placeholder={
                          argSchema?.type ? `${argSchema.type}` : "Value"
                        }
                        className="font-mono text-sm resize-none min-h-[36px]"
                        rows={1}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeArgument(toolIndex, key)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>

            {toolCall.toolName &&
              getAvailableArguments(toolIndex).length > 0 && (
                <Popover
                  open={openArgCombobox === `${toolIndex}`}
                  onOpenChange={(open) =>
                    setOpenArgCombobox(open ? `${toolIndex}` : null)
                  }
                >
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 text-xs">
                      <Plus className="h-3 w-3 mr-1" />
                      Add argument
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-full max-w-[400px] p-0"
                    align="start"
                  >
                    <Command>
                      <CommandInput
                        placeholder="Search arguments..."
                        className="h-8 text-xs"
                      />
                      <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
                        No argument found.
                      </CommandEmpty>
                      <CommandGroup className="max-h-[200px] overflow-y-auto p-1">
                        {getAvailableArguments(toolIndex)
                          .filter(
                            (arg) =>
                              !toolCall.arguments.hasOwnProperty(arg.key),
                          )
                          .map((arg) => (
                            <CommandItem
                              key={arg.key}
                              value={arg.key}
                              onSelect={() => {
                                addArgument(toolIndex, arg.key);
                                setOpenArgCombobox(null);
                              }}
                              className="px-2 py-1.5 cursor-pointer"
                            >
                              <div className="flex flex-col flex-1">
                                <span className="font-mono text-xs">
                                  {arg.key}
                                </span>
                                {arg.schema?.description && (
                                  <span className="text-[10px] text-muted-foreground leading-tight">
                                    {arg.schema.description}
                                  </span>
                                )}
                                {arg.schema?.type && (
                                  <span className="text-[10px] text-muted-foreground leading-tight">
                                    Type: {arg.schema.type}
                                  </span>
                                )}
                              </div>
                            </CommandItem>
                          ))}
                      </CommandGroup>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
          </div>
        </div>
      ))}

      <Button variant="outline" onClick={addToolCall} className="w-full">
        <Plus className="h-4 w-4 mr-2" />
        Add expected tool call
      </Button>
    </div>
  );
}
