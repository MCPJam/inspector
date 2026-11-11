/**
 * Controls a selected skill row carries in the environment skills picker,
 * shared by its Library rows and its MCP-server rows.
 */
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

/**
 * "Latest" vs an exact version, for ONE selected skill.
 *
 * Each caller loads its own history when the menu first opens (`onOpen`): a
 * picker listing 20 skills should not fetch 20 histories nobody looked at.
 * Until then the control shows what it already knows: Latest, and the
 * version Latest resolves to when the caller has it.
 *
 * Latest is the default and stays the default. Pinning is the deliberate act
 * (hold this environment at a known revision so a comparison means something),
 * so it is never selected on the user's behalf.
 */
export function SkillVersionSelect({
  label,
  latestLabel,
  versions,
  loading,
  pinnedVersionId,
  disabled,
  onOpen,
  onChange,
}: {
  /** The control's accessible name. */
  label: string;
  latestLabel: string;
  /** Every version, newest first, once loaded. */
  versions: ReadonlyArray<{ id: string; label: string }> | null;
  loading: boolean;
  pinnedVersionId: string | null;
  disabled: boolean;
  onOpen: () => void;
  onChange: (versionId: string | null) => void;
}) {
  const pinned = versions?.some((version) => version.id === pinnedVersionId);

  // The first option is always Latest. A native select shows the chosen
  // option's own text, so a pin already reads as its version; relabelling
  // this option with it would list that version twice and hide Latest.
  return (
    <select
      className={cn(
        "ml-auto shrink-0 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px]",
        pinnedVersionId && "border-warning/60",
      )}
      aria-label={label}
      disabled={disabled}
      value={pinnedVersionId ?? ""}
      onMouseDown={(e) => {
        // Opening the control is what triggers the fetch; stop the click from
        // reaching the row Label, which would toggle the checkbox.
        e.stopPropagation();
        onOpen();
      }}
      onClick={(e) => e.stopPropagation()}
      onFocus={onOpen}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    >
      <option value="">{latestLabel}</option>
      {loading ? <option disabled>Loading…</option> : null}
      {(versions ?? []).map((version) => (
        <option key={version.id} value={version.id}>
          {version.label}
        </option>
      ))}
      {/* A pin whose history hasn't loaded still needs a selectable option, or
          the control would silently reset it to Latest on first render. */}
      {pinnedVersionId && !pinned ? (
        <option value={pinnedVersionId}>Pinned version</option>
      ) : null}
    </select>
  );
}

/**
 * The removal for a partly-on skill that can't be turned on everywhere. A
 * button of its own, because a click on a partly-on checkbox means "on".
 */
export function RemoveEverywhere({
  disabled,
  onRemove,
}: {
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-1 h-6 self-start px-2 text-[11px]"
      disabled={disabled}
      onClick={(event) => {
        // The row is a label: keep the click from reaching its checkbox.
        event.preventDefault();
        onRemove();
      }}
    >
      Remove from every client
    </Button>
  );
}
