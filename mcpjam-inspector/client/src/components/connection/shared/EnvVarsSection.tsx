import { useId } from "react";
import { Input } from "@mcpjam/design-system/input";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";

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
  // Per-instance so the add and edit forms can be mounted at the same time
  // without colliding on a shared element id.
  const bodyId = useId();

  // Adding from the collapsed state used to append an invisible row — expand
  // first so the new row is always where the click points.
  const handleAdd = () => {
    if (!showEnvVars) {
      onToggle();
    }
    onAdd();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={showEnvVars}
          aria-controls={bodyId}
          className="group flex items-center gap-1.5 text-left"
        >
          {showEnvVars ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">
            Environment Variables
          </span>
          {envVars.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
              {envVars.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={isHidden}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>

      <div id={bodyId}>
        {!showEnvVars && (
          <p className="text-xs text-muted-foreground">
            Passed to your MCP server process (e.g. API keys, config values)
          </p>
        )}

        {showEnvVars && isHidden && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
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
            <button
              type="button"
              disabled={isRevealing || !onReveal}
              onClick={onReveal}
              className="rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRevealing ? "Revealing..." : "Reveal"}
            </button>
          </div>
        )}

        {showEnvVars && !isHidden && envVars.length === 0 && (
          <button
            type="button"
            onClick={onAdd}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add variable
          </button>
        )}

        {showEnvVars && envVars.length > 0 && (
          // -mx-1/px-1 keeps focus rings from being clipped by the scroller.
          <div className="-mx-1 max-h-52 space-y-1.5 overflow-y-auto px-1">
            {envVars.map((envVar, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={envVar.key}
                  onChange={(e) => onUpdate(index, "key", e.target.value)}
                  placeholder="KEY"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label={`Environment variable ${index + 1} name`}
                  className="h-8 flex-1 font-mono text-xs"
                />
                <span
                  aria-hidden="true"
                  className="shrink-0 select-none text-xs text-muted-foreground/70"
                >
                  =
                </span>
                <Input
                  value={envVar.value}
                  onChange={(e) => onUpdate(index, "value", e.target.value)}
                  placeholder="value"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label={`Environment variable ${index + 1} value`}
                  className="h-8 flex-[1.4] font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  aria-label={
                    envVar.key
                      ? `Remove ${envVar.key}`
                      : `Remove variable ${index + 1}`
                  }
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
