import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useMaskedValues } from "../hooks/use-masked-values";
import { HiddenValuesField } from "./HiddenValuesField";
import { MaskedValueInput } from "./MaskedValueInput";
import { StoredKeyRows } from "./StoredKeyRows";

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
  /** Names of the variables the server has stored, once they've been fetched.
   * Lets the masked rows say which variables are set. */
  storedEnvKeys?: string[];
  /** Asks for those names. Called once, when the section is first opened on a
   * server whose values are stored — names cost no secret, values do. */
  onRequestStoredKeys?: () => void;
  /** Identity of the server these rows belong to. Re-masks everything when it
   * changes, so a form that swaps servers without remounting can't carry an
   * uncovered row onto the next server's values. */
  maskingKey?: string | null;
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
  storedEnvKeys,
  onRequestStoredKeys,
  maskingKey,
}: EnvVarsSectionProps) {
  const isHidden = hasStoredEnv && envVars.length === 0;
  const storedKeys = storedEnvKeys ?? [];
  const rowCount = isHidden ? storedKeys.length : envVars.length;
  // Per-instance so the add and edit forms can be mounted at the same time
  // without colliding on a shared element id.
  const bodyId = useId();

  const masked = useMaskedValues(maskingKey);

  // Adding from the collapsed state used to append an invisible row — expand
  // first so the new row is always where the click points.
  const handleAdd = () => {
    if (!showEnvVars) {
      onToggle();
    }
    masked.markAdded(envVars.length);
    onAdd();
  };

  const handleRemove = (index: number) => {
    masked.dropAt(index);
    onRemove(index);
  };

  // Opening the section asks *what is configured*, so it fetches the names —
  // `onRequestStoredKeys` returns key names with no values attached. It must
  // not fetch the values: `onReveal` decrypts the whole secret set and drops it
  // into form state, so binding that to a disclosure would turn an idle chevron
  // click into a secret access. The eye on a row is what asks for a value.
  const keysRequested = useRef(false);
  useEffect(() => {
    if (!showEnvVars || !isHidden || !onRequestStoredKeys) return;
    // Once per mount, so a failed fetch doesn't re-fire on every render.
    if (keysRequested.current) return;
    keysRequested.current = true;
    onRequestStoredKeys();
  }, [showEnvVars, isHidden, onRequestStoredKeys]);

  // Which stored row asked to be uncovered. The reveal returns the whole set,
  // so the row is remembered by name and matched once the values land — the
  // server is free to hand them back in a different order than the names came.
  const [pendingRevealKey, setPendingRevealKey] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingRevealKey) return;
    const index = envVars.findIndex((envVar) => envVar.key === pendingRevealKey);
    if (index === -1) return;
    masked.show(index);
    setPendingRevealKey(null);
  }, [envVars, masked, pendingRevealKey]);

  const handleRevealStoredKey = (key: string) => {
    setPendingRevealKey(key);
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
          {/* Counts the stored rows too, once their names are known — "how
              many are set" is part of what the section is asked. The stored
              count only stands in while those rows are what's on screen;
              after a reveal the form's own rows are the truth, including
              when the user has deleted them all. */}
          {rowCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
              {rowCount}
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

        {showEnvVars && isHidden && storedKeys.length > 0 && (
          <StoredKeyRows
            keys={storedKeys}
            separator="="
            rowNoun="Environment variable"
            isRevealing={isRevealing}
            error={revealError}
            onReveal={handleRevealStoredKey}
          />
        )}

        {/* No names yet — the fetch is in flight, or it failed and this is the
            retry. One anonymous mask says less than named rows, but it is all
            there is to say before the names arrive. */}
        {showEnvVars && isHidden && storedKeys.length === 0 && (
          <HiddenValuesField
            subject="environment variables"
            isRevealing={isRevealing}
            error={revealError}
            onReveal={onReveal}
          />
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
                  <MaskedValueInput
                    value={envVar.value}
                    onChange={(value) => onUpdate(index, "value", value)}
                    visible={masked.isVisible(index)}
                    onToggleVisibility={() => masked.toggle(index)}
                    inputLabel={`Environment variable ${index + 1} value`}
                    subject={label}
                    className="flex-[1.4]"
                  />
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
