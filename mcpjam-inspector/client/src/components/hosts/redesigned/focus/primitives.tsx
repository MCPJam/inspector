import { useId, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { cn } from "@/lib/utils";

/**
 * Card with title + optional subtitle/right-aligned action used by every
 * focus-overlay section. One per "FocusBlock" in the design handoff.
 */
export function FocusBlock({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-host-focus-block
      className={cn(
        "rounded-[10px] border border-border bg-background p-3.5",
        className,
      )}
    >
      <header className="mb-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-tight">{title}</h3>
          {subtitle ? (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

/**
 * Label-on-left, control-on-right field row. Used for short scalar inputs
 * inside FocusBlocks. For multi-line / list controls use the block body
 * directly.
 */
export function FieldRow({
  label,
  description,
  control,
}: {
  // ReactNode (not just string) so callers can inject inline affordances
  // — e.g. an info-icon tooltip — without forking the primitive.
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium">{label}</span>
        <div className="shrink-0">{control}</div>
      </div>
      {description ? (
        <p className="text-[11px] text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * Tri-state capability toggle row used by Apps Extension's host
 * capabilities and Protocol's base capabilities.
 *
 * Tri-state semantics:
 *  - `state === "inherits"`: muted display of `presetValueLabel`; an
 *    "Override" button surfaces the affordance to write into
 *    `hostCapabilitiesOverride`.
 *  - `state === "override-on"`: explicit on; toggle off → emits
 *    `onOverrideOff` (which writes the key with value `false` if the
 *    domain considers `false` meaningful, OR removes the key, depending
 *    on what the caller passes).
 *  - `state === "override-off"`: explicit off; toggle on → emits
 *    `onOverrideOn`.
 *
 * Callers own the override map mutation; this row only renders + emits.
 */
export function CapabilityToggleRow({
  icon,
  name,
  description,
  state,
  presetValueLabel,
  subChip,
  onOverrideOn,
  onOverrideOff,
}: {
  icon: ReactNode;
  name: string;
  description: ReactNode;
  state: "inherits" | "override-on" | "override-off";
  presetValueLabel: string;
  subChip?: ReactNode;
  onOverrideOn: () => void;
  onOverrideOff: () => void;
}) {
  const reactId = useId();
  const checked = state === "override-on";
  const advertisedByPreset = presetValueLabel === "advertised";
  const advertised = state === "inherits" ? advertisedByPreset : checked;
  return (
    <div className="flex items-start gap-3 rounded-md border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <label
            htmlFor={`${reactId}-toggle`}
            className="font-mono text-[12px] font-semibold"
          >
            {name}
          </label>
          {subChip ? <Chip tone="neutral">{subChip}</Chip> : null}
          {advertised ? null : (
            <span className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground/80">
              not advertised
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          id={`${reactId}-toggle`}
          checked={advertised}
          onCheckedChange={(next) => (next ? onOverrideOn() : onOverrideOff())}
          aria-label={`${name} toggle`}
        />
      </div>
    </div>
  );
}

/**
 * Thin wrapper around ToggleGroup so callers don't reimplement the
 * single-selection wiring. Use for SEP-1865 sandbox mode etc.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  ariaLabel: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        // ToggleGroup emits "" when user clicks the already-selected option;
        // ignore that to keep the control single-select-required.
        if (next === "") return;
        onChange(next as T);
      }}
      aria-label={ariaLabel}
      className="inline-flex gap-1 rounded-md bg-muted/40 p-0.5"
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          className={cn(
            "h-7 rounded-[6px] px-2.5 text-[11.5px] font-medium",
            "motion-safe:transition-transform motion-safe:duration-150 motion-safe:active:scale-[0.96]",
            "data-[state=on]:bg-background data-[state=on]:shadow-sm",
          )}
          title={opt.hint}
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * Pill / chip primitive used throughout the focus overlay. Wraps a small
 * coloured label with optional remove affordance.
 */
export function Chip({
  children,
  tone = "neutral",
  active,
  mono,
  onRemove,
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "info" | "warning";
  active?: boolean;
  mono?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]",
        mono && "font-mono",
        tone === "neutral" && "border-border/70 bg-muted/40 text-foreground/80",
        tone === "primary" &&
          "border-primary/40 bg-primary/10 text-primary",
        tone === "info" &&
          "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        tone === "warning" &&
          "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        active && "ring-1 ring-primary/40",
      )}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-0.5 ml-0.5 inline-flex size-3.5 items-center justify-center rounded-full hover:bg-foreground/10"
          aria-label="Remove"
        >
          <X className="size-2.5" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Add-item dashed pill, used for "Add MIME type", "Add version", etc.
 * Toggles between a label-mode pill and an input on click.
 */
export function AddItemPill({
  label,
  placeholder,
  value,
  onValueChange,
  onAdd,
  active,
  onActivate,
  onCancel,
  validate,
}: {
  label: string;
  placeholder: string;
  value: string;
  onValueChange: (next: string) => void;
  onAdd: () => void;
  active: boolean;
  onActivate: () => void;
  onCancel: () => void;
  validate?: (raw: string) => string | null;
}) {
  if (!active) {
    return (
      <button
        type="button"
        onClick={onActivate}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/70 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
      >
        <Plus className="size-3" />
        {label}
      </button>
    );
  }
  const error = validate?.(value);
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        autoFocus
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-44 px-2 text-[11px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !error && value.trim() !== "") {
            e.preventDefault();
            onAdd();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[11px]"
        disabled={!!error || value.trim() === ""}
        onClick={onAdd}
      >
        Add
      </Button>
      {error ? (
        <span className="text-[10.5px] text-destructive">{error}</span>
      ) : null}
    </span>
  );
}
