import { useId } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Switch } from "@mcpjam/design-system/switch";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";

const ORDER_OPTIONS: Array<{
  value: Exclude<EvalMatchOptions["toolCallOrder"], undefined>;
  label: string;
}> = [
  { value: "strict", label: "Strict order" },
  { value: "superset", label: "Allow gaps (superset)" },
  { value: "ignore", label: "Any order" },
];

const ARGS_OPTIONS: Array<{
  value: Exclude<EvalMatchOptions["argumentMatching"], undefined>;
  label: string;
}> = [
  { value: "partial", label: "Partial" },
  { value: "exact", label: "Exact" },
  { value: "ignore", label: "Ignore" },
];

interface ValidatorsSectionProps {
  /**
   * What this layer has pinned. `undefined` field = follows the layer above.
   * Direct edits are stored here; the dropdowns themselves always show the
   * resolved (effective) value, so the user never sees an "inherit" sentinel.
   */
  value: EvalMatchOptions | undefined;
  /**
   * What the next layer up resolves to. Used to (a) show concrete values in
   * the dropdowns when this layer hasn't pinned a field, and (b) detect when
   * a user picked the same value as the inherited one (we treat that as a
   * no-op and keep the field unpinned).
   *
   * `allowExtraToolCalls` on this object is shimmed at read time
   * (`true → null`, `false → 0`) so legacy persisted records still render
   * correctly while we transition to `maxExtraToolCalls`.
   */
  inheritedFrom?: Required<
    Omit<EvalMatchOptions, "allowExtraToolCalls">
  > & { allowExtraToolCalls?: boolean };
  onChange: (next: EvalMatchOptions | undefined) => void;
  title?: string;
  description?: string;
  density?: "default" | "compact";
}

function pruneUndefined(
  options: EvalMatchOptions,
): EvalMatchOptions | undefined {
  const entries = Object.entries(options).filter(([, v]) => v !== undefined);
  return entries.length === 0
    ? undefined
    : (Object.fromEntries(entries) as EvalMatchOptions);
}

/**
 * LEGACY: read-side shim for `inheritedFrom`. New code writes
 * `maxExtraToolCalls` directly; old persisted rows may carry
 * `allowExtraToolCalls`. Translate at the boundary so the UI only ever
 * deals with the new field. Remove after v<NEXT_MINOR>.
 */
function inheritedExtrasCap(
  inheritedFrom: ValidatorsSectionProps["inheritedFrom"],
): number | null {
  if (!inheritedFrom) return MATCH_OPTIONS_DEFAULTS.maxExtraToolCalls;
  if (inheritedFrom.maxExtraToolCalls !== undefined) {
    return inheritedFrom.maxExtraToolCalls;
  }
  if (inheritedFrom.allowExtraToolCalls !== undefined) {
    return inheritedFrom.allowExtraToolCalls ? null : 0;
  }
  return MATCH_OPTIONS_DEFAULTS.maxExtraToolCalls;
}

/**
 * LEGACY: read-side shim for the layer's own pinned value. A row written
 * before the schema change still has `allowExtraToolCalls`; the UI must
 * render its number/Unlimited state correctly without an explicit
 * migration. Remove after v<NEXT_MINOR>.
 */
function localExtrasCap(
  value: EvalMatchOptions | undefined,
): number | null | undefined {
  if (!value) return undefined;
  if (value.maxExtraToolCalls !== undefined) return value.maxExtraToolCalls;
  if (value.allowExtraToolCalls !== undefined) {
    return value.allowExtraToolCalls ? null : 0;
  }
  return undefined;
}

const LABELS_COMPACT = {
  toolOrder: "Tool order",
  extras: "Extra tool calls",
  args: "Args",
} as const;

export function ValidatorsSection({
  value,
  inheritedFrom,
  onChange,
  title = "Validators",
  description,
  density = "default",
}: ValidatorsSectionProps) {
  const inherited = inheritedFrom ?? MATCH_OPTIONS_DEFAULTS;
  const isCompact = density === "compact";
  const orderLabel = isCompact ? LABELS_COMPACT.toolOrder : "Tool call order";
  const extrasLabel = isCompact ? LABELS_COMPACT.extras : "Extra tool calls";
  const argsLabel = isCompact ? LABELS_COMPACT.args : "Arguments";

  const extrasFieldId = useId();
  const extrasUnlimitedId = useId();

  const setField = <K extends keyof EvalMatchOptions>(
    field: K,
    next: EvalMatchOptions[K],
  ) => {
    const merged: EvalMatchOptions = { ...value };
    // If user picked the value already inherited from above, treat as unpin —
    // keeps state minimal and the "Reset" affordance honest.
    if (next === (inherited as Record<string, unknown>)[field]) {
      merged[field] = undefined;
    } else {
      merged[field] = next;
    }
    onChange(pruneUndefined(merged));
  };

  /**
   * Setter for `maxExtraToolCalls` that also strips any legacy
   * `allowExtraToolCalls` field from the persisted value so we don't
   * round-trip both. New writes use the new field only.
   */
  const setExtrasCap = (next: number | null | undefined) => {
    const inheritedCap = inheritedExtrasCap(inheritedFrom);
    const merged: EvalMatchOptions = { ...value };
    delete merged.allowExtraToolCalls;
    if (next === undefined || next === inheritedCap) {
      merged.maxExtraToolCalls = undefined;
    } else {
      merged.maxExtraToolCalls = next;
    }
    onChange(pruneUndefined(merged));
  };

  const orderValue: "ignore" | "strict" | "superset" =
    value?.toolCallOrder ?? inherited.toolCallOrder;

  const localCap = localExtrasCap(value);
  const inheritedCap = inheritedExtrasCap(inheritedFrom);
  const effectiveCap = localCap !== undefined ? localCap : inheritedCap;
  const extrasUnlimited = effectiveCap === null;
  const extrasNumber = effectiveCap ?? 0;

  const argsValue = value?.argumentMatching ?? inherited.argumentMatching;

  const hasAnyOverride =
    !!value &&
    (value.toolCallOrder !== undefined ||
      value.maxExtraToolCalls !== undefined ||
      value.allowExtraToolCalls !== undefined ||
      value.argumentMatching !== undefined);

  const renderRow = (
    label: string,
    selectId: string,
    selectedValue: string,
    onValueChange: (v: string) => void,
    options: Array<{ value: string; label: string }>,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={selectId} className="text-sm">
        {label}
      </Label>
      <Select value={selectedValue} onValueChange={onValueChange}>
        <SelectTrigger
          id={selectId}
          className={
            isCompact
              ? "h-8 w-[10rem] max-w-full shrink-0 text-sm"
              : "h-8 w-44 text-sm"
          }
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className={isCompact ? "space-y-2" : "space-y-3"}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">{title}</h4>
          {description && !isCompact ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              {description}
            </p>
          ) : null}
        </div>
        {hasAnyOverride ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 -mr-1 px-2 text-xs text-muted-foreground"
            onClick={() => onChange(undefined)}
            title="Discard overrides at this layer"
          >
            Reset
          </Button>
        ) : null}
      </div>
      <div className={isCompact ? "space-y-1.5" : "space-y-2"}>
        {renderRow(
          orderLabel,
          "validators-order",
          orderValue,
          (v) =>
            setField(
              "toolCallOrder",
              v as "ignore" | "strict" | "superset",
            ),
          ORDER_OPTIONS as Array<{ value: string; label: string }>,
        )}
        {/* Extras row: number input + Unlimited toggle. Unlimited persists
            null; toggling off persists the current number. */}
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={extrasFieldId} className="text-sm">
            {extrasLabel}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={extrasFieldId}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              disabled={extrasUnlimited}
              value={extrasUnlimited ? "" : String(extrasNumber)}
              placeholder={extrasUnlimited ? "—" : "0"}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setExtrasCap(0);
                  return;
                }
                const parsed = Number(raw);
                if (
                  !Number.isFinite(parsed) ||
                  !Number.isInteger(parsed) ||
                  parsed < 0
                ) {
                  // Ignore invalid keystrokes; the input itself constrains
                  // type=number, but defensive guard for paste etc.
                  return;
                }
                setExtrasCap(parsed);
              }}
              className={isCompact ? "h-8 w-16 text-sm" : "h-8 w-20 text-sm"}
              aria-label="Maximum extra tool calls"
            />
            <Label
              htmlFor={extrasUnlimitedId}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Switch
                id={extrasUnlimitedId}
                checked={extrasUnlimited}
                onCheckedChange={(checked) => {
                  if (checked) {
                    // Unlimited
                    setExtrasCap(null);
                  } else {
                    // Drop unlimited; default to 0 (strict, no extras) so
                    // the new bound is immediately meaningful.
                    setExtrasCap(0);
                  }
                }}
                aria-label="Allow unlimited extra tool calls"
              />
              <span>Unlimited</span>
            </Label>
          </div>
        </div>
        {renderRow(
          argsLabel,
          "validators-args",
          argsValue,
          (v) =>
            setField(
              "argumentMatching",
              v as "partial" | "exact" | "ignore",
            ),
          ARGS_OPTIONS as Array<{ value: string; label: string }>,
        )}
      </div>
    </div>
  );
}
