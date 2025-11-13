import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

type ToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

type ExpectedToolsEditorProps = {
  toolCalls: ToolCall[];
  onChange: (toolCalls: ToolCall[]) => void;
};

export function ExpectedToolsEditor({
  toolCalls,
  onChange,
}: ExpectedToolsEditorProps) {
  const addToolCall = () => {
    onChange([...toolCalls, { toolName: "", arguments: {} }]);
  };

  const removeToolCall = (index: number) => {
    onChange(toolCalls.filter((_, i) => i !== index));
  };

  const updateToolName = (index: number, toolName: string) => {
    const updated = [...toolCalls];
    updated[index] = { ...updated[index], toolName };
    onChange(updated);
  };

  const addArgument = (toolIndex: number) => {
    const updated = [...toolCalls];
    const existingArgs = updated[toolIndex].arguments;
    let newKey = "arg";
    let counter = 1;
    while (existingArgs[newKey] !== undefined) {
      newKey = `arg${counter}`;
      counter++;
    }
    updated[toolIndex] = {
      ...updated[toolIndex],
      arguments: { ...existingArgs, [newKey]: "" },
    };
    onChange(updated);
  };

  const removeArgument = (toolIndex: number, argKey: string) => {
    const updated = [...toolCalls];
    const newArgs = { ...updated[toolIndex].arguments };
    delete newArgs[argKey];
    updated[toolIndex] = { ...updated[toolIndex], arguments: newArgs };
    onChange(updated);
  };

  const updateArgumentKey = (
    toolIndex: number,
    oldKey: string,
    newKey: string
  ) => {
    const updated = [...toolCalls];
    const args = { ...updated[toolIndex].arguments };
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
    value: string
  ) => {
    const updated = [...toolCalls];
    const args = { ...updated[toolIndex].arguments };

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
              <Input
                value={toolCall.toolName}
                onChange={(e) => updateToolName(toolIndex, e.target.value)}
                placeholder="e.g. get_transactions"
                className="font-mono text-sm"
              />
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
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                Arguments
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addArgument(toolIndex)}
                className="h-7 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add argument
              </Button>
            </div>

            {Object.entries(toolCall.arguments).length === 0 ? (
              <div className="text-xs text-muted-foreground italic py-2">
                No arguments. Click "Add argument" to add one.
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(toolCall.arguments).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <Input
                      value={key}
                      onChange={(e) =>
                        updateArgumentKey(toolIndex, key, e.target.value)
                      }
                      placeholder="Key"
                      className="flex-1 font-mono text-sm"
                    />
                    <Input
                      value={
                        typeof value === "string"
                          ? value
                          : JSON.stringify(value)
                      }
                      onChange={(e) =>
                        updateArgumentValue(toolIndex, key, e.target.value)
                      }
                      placeholder="Value"
                      className="flex-[2] font-mono text-sm"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeArgument(toolIndex, key)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        onClick={addToolCall}
        className="w-full"
      >
        <Plus className="h-4 w-4 mr-2" />
        Add expected tool call
      </Button>
    </div>
  );
}
