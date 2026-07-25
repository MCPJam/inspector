import { useId, useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import { ChevronDown, ChevronRight, Eye, EyeOff, Plus, X } from "lucide-react";

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

  // Values render masked so an API key isn't sitting in cleartext for anyone
  // looking at the screen. This is shoulder-surfing cover, not access control:
  // the value is already in the form, so the eye is a pure client-side toggle —
  // no fetch, no round-trip. `defaultVisible` sets the baseline for rows we
  // haven't heard about yet; `valueOverrides` holds the per-row eye state.
  const [defaultVisible, setDefaultVisible] = useState(false);
  const [valueOverrides, setValueOverrides] = useState<Record<number, boolean>>(
    {}
  );
  const isValueVisible = (index: number) =>
    valueOverrides[index] ?? defaultVisible;

  const toggleValueVisibility = (index: number) => {
    const next = !isValueVisible(index);
    setValueOverrides((prev) => ({ ...prev, [index]: next }));
  };

  // Adding from the collapsed state used to append an invisible row — expand
  // first so the new row is always where the click points.
  const handleAdd = () => {
    if (!showEnvVars) {
      onToggle();
    }
    // The row you're about to type into starts unmasked; masking your own
    // keystrokes as you enter them helps nobody.
    setValueOverrides((prev) => ({ ...prev, [envVars.length]: true }));
    onAdd();
  };

  // Rows are keyed by position, so dropping one has to slide every override
  // above it down a slot — otherwise the eye state lands on the wrong variable.
  const handleRemove = (index: number) => {
    setValueOverrides((prev) => {
      const next: Record<number, boolean> = {};
      for (const [key, visible] of Object.entries(prev)) {
        const at = Number(key);
        if (at === index) continue;
        next[at > index ? at - 1 : at] = visible;
      }
      return next;
    });
    onRemove(index);
  };

  // Reveal is an explicit "show me the stored values", so the rows it fetches
  // arrive unmasked. Each eye can put one back.
  const handleReveal = () => {
    setDefaultVisible(true);
    setValueOverrides({});
    onReveal?.();
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
              onClick={handleReveal}
              className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {isRevealing ? "Revealing..." : "Reveal"}
            </button>
          </div>
        )}

        {showEnvVars && !isHidden && envVars.length === 0 && (
          <button
            type="button"
            onClick={handleAdd}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add variable
          </button>
        )}

        {showEnvVars && envVars.length > 0 && (
          // -mx-1/px-1 keeps focus rings from being clipped by the scroller.
          <div className="-mx-1 max-h-52 space-y-1.5 overflow-y-auto px-1">
            {envVars.map((envVar, index) => {
              const valueVisible = isValueVisible(index);
              const label = envVar.key || `variable ${index + 1}`;
              return (
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
                  <div className="relative flex-[1.4]">
                    <Input
                      type={valueVisible ? "text" : "password"}
                      value={envVar.value}
                      onChange={(e) => onUpdate(index, "value", e.target.value)}
                      placeholder="value"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      // Keeps the browser's password manager from offering to
                      // save an MCP server's env var as a login.
                      autoComplete="off"
                      aria-label={`Environment variable ${index + 1} value`}
                      className="h-8 w-full pr-8 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => toggleValueVisibility(index)}
                      aria-label={
                        valueVisible
                          ? `Hide value for ${label}`
                          : `Show value for ${label}`
                      }
                      className="absolute right-0.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {valueVisible ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(index)}
                    aria-label={`Remove ${label}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
