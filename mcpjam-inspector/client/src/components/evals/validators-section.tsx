import type { ReactNode } from "react";
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
import { OverrideBadge } from "./override-badge";

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
  /**
   * When true, render per-control "(suite default · X)" or
   * "(overriding · suite: X)" chips next to each field label, with a
   * per-control reset affordance. Used at the case-edit and run-popover
   * layers; the suite-edit page leaves this off because it IS the source.
   *
   * When true, inheriting controls are also visually greyed (the dropdown
   * still shows the resolved value so the user sees what'll apply, but the
   * input is disabled to reinforce that the case isn't pinning it).
   */
  showBadges?: boolean;
  /**
   * When true, suppress the "Inherited" chip on inheriting rows but still
   * render the "overriding · suite: X" chip on overridden rows. Used by the
   * suite-header Run-overrides popover, where the popover's intro copy
   * already establishes that every field inherits by default — labeling
   * each row "Inherited" is then pure noise.
   */
  hideInheritedBadge?: boolean;
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

// ─── Pretty-printers for badge labels ─────────────────────────────────────
//
// Keep these inline (rather than importing the SDK enum maps) so the chip
// text stays consistent with the dropdown option labels above, even if the
// SDK reshapes its internal vocabulary.

function orderLabelFor(value: "ignore" | "strict" | "superset"): string {
  return ORDER_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function argsLabelFor(value: "exact" | "partial" | "ignore"): string {
  return ARGS_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function extrasLabelFor(cap: number | null): string {
  if (cap === null) return "Unlimited";
  if (cap === 0) return "0 (strict)";
  return `${cap}`;
}

/**
 * True iff this layer pins `maxExtraToolCalls` (directly or via the
 * legacy `allowExtraToolCalls` shim). Used by the badge logic to
 * distinguish inheriting from explicit.
 */
function isExtrasPinned(value: EvalMatchOptions | undefined): boolean {
  if (!value) return false;
  return (
    value.maxExtraToolCalls !== undefined ||
    value.allowExtraToolCalls !== undefined
  );
}

export function ValidatorsSection({
  value,
  inheritedFrom,
  onChange,
  title = "Validators",
  description,
  density = "default",
  showBadges = false,
  hideInheritedBadge = false,
}: ValidatorsSectionProps) {
  const inherited = inheritedFrom ?? MATCH_OPTIONS_DEFAULTS;
  const isCompact = density === "compact";
  const orderLabel = isCompact ? LABELS_COMPACT.toolOrder : "Tool call order";
  const extrasLabel = isCompact ? LABELS_COMPACT.extras : "Extra tool calls";
  const argsLabel = isCompact ? LABELS_COMPACT.args : "Arguments";

  const extrasFieldId = useId();
  const extrasUnlimitedId = useId();

  // Per-field inheritance state. `value?.field === undefined` is the
  // canonical "inheriting" marker (per Phase 1 layered resolver semantics);
  // `null` on `maxExtraToolCalls` is an explicit "unlimited" override and
  // counts as overriding.
  const orderInheriting = value?.toolCallOrder === undefined;
  const extrasInheriting = !isExtrasPinned(value);
  const argsInheriting = value?.argumentMatching === undefined;

  // Inherited cap for badge labels — reuses the legacy shim so old rows
  // surface a sensible chip.
  const inheritedExtrasForLabel = inheritedExtrasCap(inheritedFrom);
  const inheritedOrderForLabel = inherited.toolCallOrder;
  const inheritedArgsForLabel = inherited.argumentMatching;

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

  /**
   * Reset a single field at this layer back to inherit. Writes `undefined`
   * (NOT the resolved default) so future suite-default changes continue to
   * propagate through the resolver.
   */
  const resetField = (field: keyof EvalMatchOptions) => {
    if (!value) return;
    const merged: EvalMatchOptions = { ...value };
    delete merged[field];
    // When resetting maxExtraToolCalls, also clear any legacy field so
    // we don't accidentally leave an old shim value behind.
    if (field === "maxExtraToolCalls") {
      delete merged.allowExtraToolCalls;
    }
    onChange(pruneUndefined(merged));
  };

  const resetExtras = () => {
    if (!value) return;
    const merged: EvalMatchOptions = { ...value };
    delete merged.maxExtraToolCalls;
    delete merged.allowExtraToolCalls;
    onChange(pruneUndefined(merged));
  };

  const renderRow = (
    label: string,
    selectId: string,
    selectedValue: string,
    onValueChange: (v: string) => void,
    options: Array<{ value: string; label: string }>,
    badge?: ReactNode,
    disabled?: boolean,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <Label htmlFor={selectId} className="text-sm">
          {label}
        </Label>
        {badge}
      </div>
      <Select
        value={selectedValue}
        onValueChange={onValueChange}
        disabled={disabled}
      >
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

  const showHeader = Boolean(title) || Boolean(description);
  return (
    <div className={isCompact ? "space-y-2" : "space-y-3"}>
      {showHeader || hasAnyOverride ? (
        <div className="flex items-start justify-between gap-2">
          <div>
            {title ? <h4 className="text-sm font-medium">{title}</h4> : null}
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
      ) : null}
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
          showBadges && !(hideInheritedBadge && orderInheriting) ? (
            <OverrideBadge
              isInheriting={orderInheriting}
              suiteDefaultLabel={orderLabelFor(inheritedOrderForLabel)}
              onReset={
                orderInheriting ? undefined : () => resetField("toolCallOrder")
              }
            />
          ) : undefined,
          // Inheriting controls stay editable: picking a non-suite-default
          // value is how the user authors the first override at this layer.
          // The badge surfaces the inherited value; the select drives it.
          false,
        )}
        {/* Extras row: number input + Unlimited toggle. Unlimited persists
            null; toggling off persists the current number. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <Label htmlFor={extrasFieldId} className="text-sm">
              {extrasLabel}
            </Label>
            {showBadges && !(hideInheritedBadge && extrasInheriting) ? (
              <OverrideBadge
                isInheriting={extrasInheriting}
                suiteDefaultLabel={extrasLabelFor(inheritedExtrasForLabel)}
                onReset={extrasInheriting ? undefined : resetExtras}
              />
            ) : null}
          </div>
          {/*
            Extras editor: a single control surface that swaps between a
            number input (capped extras) and an "Unlimited" pill, never
            both. Showing a disabled empty number input next to an active
            Unlimited toggle (the old layout) read as a broken form field.
          */}
          <div className="flex items-center gap-2">
            {extrasUnlimited ? null : (
              <Input
                id={extrasFieldId}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={String(extrasNumber)}
                placeholder="0"
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
            )}
            <Label
              htmlFor={extrasUnlimitedId}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Switch
                id={extrasUnlimitedId}
                checked={extrasUnlimited}
                onCheckedChange={(checked) => {
                  if (checked) {
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
          showBadges && !(hideInheritedBadge && argsInheriting) ? (
            <OverrideBadge
              isInheriting={argsInheriting}
              suiteDefaultLabel={argsLabelFor(inheritedArgsForLabel)}
              onReset={
                argsInheriting
                  ? undefined
                  : () => resetField("argumentMatching")
              }
            />
          ) : undefined,
          // See note on the order row above.
          false,
        )}
      </div>
    </div>
  );
}
