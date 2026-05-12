import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";

const ORDER_OPTIONS: Array<{
  value: Exclude<EvalMatchOptions["toolCallOrder"], undefined>;
  label: string;
}> = [
  { value: "ignore", label: "Any order" },
  { value: "strict", label: "Strict" },
];

const EXTRAS_OPTIONS: Array<{ value: "true" | "false"; label: string }> = [
  { value: "true", label: "Allow extras" },
  { value: "false", label: "Forbidden" },
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
   */
  inheritedFrom?: Required<EvalMatchOptions>;
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

  const setField = <K extends keyof EvalMatchOptions>(
    field: K,
    next: EvalMatchOptions[K],
  ) => {
    const merged: EvalMatchOptions = { ...value };
    // If user picked the value already inherited from above, treat as unpin —
    // keeps state minimal and the "Reset" affordance honest.
    merged[field] = next === inherited[field] ? undefined : next;
    onChange(pruneUndefined(merged));
  };

  const orderValue: "ignore" | "strict" =
    value?.toolCallOrder ?? inherited.toolCallOrder;
  const extrasValue: "true" | "false" = (
    value?.allowExtraToolCalls ?? inherited.allowExtraToolCalls
  )
    ? "true"
    : "false";
  const argsValue = value?.argumentMatching ?? inherited.argumentMatching;

  const hasAnyOverride =
    !!value &&
    (value.toolCallOrder !== undefined ||
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
              : "h-8 w-40 text-sm"
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
          (v) => setField("toolCallOrder", v as "ignore" | "strict"),
          ORDER_OPTIONS as Array<{ value: string; label: string }>,
        )}
        {renderRow(
          extrasLabel,
          "validators-extras",
          extrasValue,
          (v) => setField("allowExtraToolCalls", v === "true"),
          EXTRAS_OPTIONS as Array<{ value: string; label: string }>,
        )}
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
