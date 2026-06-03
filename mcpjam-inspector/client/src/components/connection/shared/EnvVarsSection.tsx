import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { ChevronDown, ChevronRight } from "lucide-react";

interface EnvVarsSectionProps {
  envVars: Array<{ key: string; value: string }>;
  showEnvVars: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: "key" | "value", value: string) => void;
  hasStoredEnv?: boolean;
  isRevealing?: boolean;
  revealError?: string | null;
  onReveal?: () => void;
}

export function EnvVarsSection({
  envVars,
  showEnvVars,
  onToggle,
  onAdd,
  onRemove,
  onUpdate,
  hasStoredEnv = false,
  isRevealing = false,
  revealError,
  onReveal,
}: EnvVarsSectionProps) {
  const isHidden = hasStoredEnv && envVars.length === 0;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex w-full items-center justify-between p-3 transition-colors hover:bg-muted/50">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left"
        >
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
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isHidden}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="text-xs"
        >
          Add Variable
        </Button>
      </div>

      {showEnvVars && isHidden && (
        <div className="border-t border-border bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2">
            <div>
              <p className="text-xs font-medium text-foreground">
                Hidden — Reveal to view
              </p>
              {revealError && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {revealError}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isRevealing || !onReveal}
              onClick={onReveal}
              className="text-xs"
            >
              {isRevealing ? "Revealing..." : "Reveal"}
            </Button>
          </div>
        </div>
      )}

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
