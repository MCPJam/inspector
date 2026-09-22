/**
 * The one control that picks a Computer sandbox image.
 *
 * Every surface that pins an image sits beside the app's own pickers — the
 * composer pills, or the Client / Server group fields of the environment
 * editor — and a native `<select>` there reads as a control someone forgot to
 * finish (its own height, font, and on macOS an entirely different dropdown).
 * So this wraps the same design-system `Select` (Radix) those pickers use,
 * which is also what earns back the keyboard and screen-reader behaviour the
 * native element gave for free: the trigger is a real `combobox`, the rows are
 * `option`s, and typeahead / arrow keys / Escape come from the primitive.
 *
 * PURE PRESENTATION: the image list is passed in, so the query stays with the
 * surface that owns the feature gate (see `SandboxImagePill`).
 *
 * Radix has no empty-string value, so "no pin" travels as a sentinel and is
 * translated at the boundary — callers still see `null`, exactly as they did
 * with `e.target.value || null`.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { SandboxImageView } from "@/hooks/useSandboxImages";
import { cn } from "@/lib/utils";

/** Radix rejects `""` as an item value; `null` is the wire shape callers use. */
const NO_PIN = "__none__";

export interface SandboxImageOption {
  value: string;
  label: string;
  disabled: boolean;
}

/**
 * The option rows for a pin, minus the "no pin" row every caller renders first.
 *
 * Pure and exported so the list states — the annotations, and the two rows that
 * exist only to keep a pin VISIBLE — are testable without driving a dropdown
 * open (the same split `orderHostsByPriority` uses in `HostPicker`).
 */
export function sandboxImageOptions({
  images,
  value,
  draftNote,
  lockImages = false,
}: {
  /** `undefined` while the image query is in flight. */
  images: SandboxImageView[] | undefined;
  value: string | null;
  /** Suffix for a personal draft, which no other member can resolve. */
  draftNote: string;
  /** Disable every real image (cloud sandboxes unreachable), pin still clearable. */
  lockImages?: boolean;
}): SandboxImageOption[] {
  const rows: SandboxImageOption[] = (images ?? []).map((img) => {
    const ready = img.currentBuild?.status === "ready";
    // A per-user draft can't be resolved by anyone else at launch, so it is
    // listed (so its absence isn't a mystery) but never selectable.
    const isDraft = img.sharing !== "project";
    return {
      value: img.environmentId,
      label: `${img.name}${isDraft ? draftNote : ready ? "" : " (not built)"}`,
      disabled: isDraft || lockImages,
    };
  });

  // A pin with no matching row would leave the control displaying the "no pin"
  // row — a pinned environment reading as unpinned. Two DIFFERENT causes need
  // two different labels:
  //
  //  1. still loading: say so. Labeling it "Unknown image" here would alarm an
  //     admin about a perfectly valid pin on every mount until the query
  //     resolves.
  //  2. resolved and genuinely absent (deleted image): name it, so the pin
  //     stays visible and explicitly clearable instead of being silently
  //     coerced to "none" on the next save.
  if (value && images === undefined) {
    rows.push({ value, label: "Loading image…", disabled: true });
  } else if (value && !rows.some((row) => row.value === value)) {
    rows.push({
      value,
      label: `Unknown image (${value})`,
      disabled: true,
    });
  }
  return rows;
}

export function SandboxImagePicker({
  images,
  value,
  onChange,
  noPinLabel,
  draftNote,
  lockImages,
  disabled,
  variant,
  id,
  testId,
  ariaLabel = "Sandbox image",
}: {
  images: SandboxImageView[] | undefined;
  value: string | null;
  onChange: (next: string | null) => void;
  /** Label of the opt-out row, which is also the trigger's resting label. */
  noPinLabel: string;
  draftNote: string;
  lockImages?: boolean;
  disabled?: boolean;
  /** `pill` for the composer strip, `field` for a labelled form row. */
  variant: "pill" | "field";
  /** Wire a `<Label htmlFor>` to the trigger, as a form row does. */
  id?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const options = sandboxImageOptions({
    images,
    value,
    draftNote,
    lockImages,
  });

  return (
    <Select
      value={value ?? NO_PIN}
      onValueChange={(next) => onChange(next === NO_PIN ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        data-testid={testId}
        aria-label={ariaLabel}
        size={variant === "pill" ? "sm" : "default"}
        className={cn(
          "min-w-0 max-w-full",
          // The pill shape of the composer strip, matching the clients and
          // skills triggers it stands next to.
          variant === "pill" &&
            "max-w-[200px] rounded-full border-border/60 bg-muted/40 px-2 text-xs hover:bg-muted/60"
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* Always live, even when `lockImages` disables the images: a pin
            seeded from a saved environment or draft must remain clearable. */}
        <SelectItem value={NO_PIN}>{noPinLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
