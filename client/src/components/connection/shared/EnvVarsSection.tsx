import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight } from "lucide-react";

interface EnvVarsSectionProps {
  envVars: Array<{ key: string; value: string }>;
  showEnvVars: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: "key" | "value", value: string) => void;
}

export function EnvVarsSection({
  envVars,
  showEnvVars,
  onToggle,
  onAdd,
  onRemove,
  onUpdate,
}: EnvVarsSectionProps) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {showEnvVars ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">
            Environment Variables
          </span>
          {envVars.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({envVars.length})
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="text-xs"
        >
          Add Variable
        </Button>
      </button>

      {showEnvVars && envVars.length > 0 && (
        <div className="p-4 space-y-2 border-t border-border bg-muted/30 max-h-48 overflow-y-auto">
          {envVars.map((envVar, index) => (
            <div key={index} className="flex gap-2 items-center">
              <Input
                value={envVar.key}
                onChange={(e) => onUpdate(index, "key", e.target.value)}
                placeholder="VARIABLE_NAME"
                className="flex-1 text-xs"
              />
              <Input
                value={envVar.value}
                onChange={(e) => onUpdate(index, "value", e.target.value)}
                placeholder="value"
                className="flex-1 text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onRemove(index)}
                className="px-2 text-xs"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}

      {!showEnvVars && (
        <div className="px-3 pb-3">
          <p className="text-xs text-muted-foreground">
            Environment variables for your MCP server process (e.g. API keys,
            config values)
          </p>
        </div>
      )}
    </div>
  );
}
