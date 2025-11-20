import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Combobox } from "@/components/ui/combobox";

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
    if (!newKey || oldKey === newKey) {
      return;
    }

    const updated = [...toolCalls];
    const currentArgs = updated[toolIndex].arguments || {};
    const entries = Object.entries(currentArgs);

    const reorderedEntries = entries.map(([key, value]) =>
      key === oldKey ? [newKey, value] : [key, value],
    );

    updated[toolIndex] = {
      ...updated[toolIndex],
      arguments: Object.fromEntries(reorderedEntries),
    };

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

  const isArgumentValueInvalid = (value: any): boolean => {
    return value === "";
  };

  const isToolNameInvalid = (toolName: string): boolean => {
    return !toolName || toolName.trim() === "";
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
                <Combobox
                  items={availableTools.map((tool) => ({
                    value: tool.name,
                    label: tool.name,
                    description: tool.description,
                  }))}
                  value={toolCall.toolName}
                  onValueChange={(val) =>
                    updateToolName(toolIndex, val as string)
                  }
                  placeholder="Select tool..."
                  searchPlaceholder="Search tools..."
                  className={cn(
                    "w-full justify-between font-mono text-sm h-9",
                    isToolNameInvalid(toolCall.toolName) &&
                      "border-destructive focus-visible:ring-destructive",
                  )}
                />
              ) : (
                <Input
                  value={toolCall.toolName}
                  onChange={(e) => updateToolName(toolIndex, e.target.value)}
                  placeholder="e.g. get_transactions"
                  className={cn(
                    "font-mono text-sm",
                    isToolNameInvalid(toolCall.toolName) &&
                      "border-destructive focus-visible:ring-destructive",
                  )}
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
                const availableArgs = getAvailableArguments(toolIndex).filter(
                  (arg) =>
                    !toolCall.arguments.hasOwnProperty(arg.key) ||
                    arg.key === key,
                );

                const isPlaceholderKey =
                  /^arg\d*$/.test(key) &&
                  !getAvailableArguments(toolIndex).some(
                    (arg) => arg.key === key,
                  );

                const comboboxItems = availableArgs.map((arg) => {
                  let description = arg.schema?.description || "";
                  if (arg.schema?.type) {
                    description += description
                      ? ` (Type: ${arg.schema.type})`
                      : `Type: ${arg.schema.type}`;
                  }
                  return {
                    value: arg.key,
                    label: arg.key,
                    description,
                  };
                });

                return (
                  <div key={key} className="flex items-start gap-2">
                    <div className="flex-1">
                      <Combobox
                        items={comboboxItems}
                        value={isPlaceholderKey ? "" : key}
                        onValueChange={(newKey) =>
                          updateArgumentKey(toolIndex, key, newKey as string)
                        }
                        placeholder="Select argument..."
                        searchPlaceholder="Search arguments..."
                        className="w-full justify-between font-mono text-sm h-9"
                      />
                      {argSchema?.description && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {argSchema.description}
                        </p>
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
                        className={cn(
                          "font-mono text-sm resize-none min-h-[36px]",
                          isArgumentValueInvalid(value) &&
                            "border-destructive focus-visible:ring-destructive",
                        )}
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

            {toolCall.toolName && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => addArgument(toolIndex)}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add argument
              </Button>
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
