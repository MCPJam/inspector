/**
 * The "All shared Library skills" choice in the environment skills picker.
 *
 * An environment on it runs every project-shared Library skill at Latest, and
 * a skill shared later joins later runs. It is stored as a scope beside
 * `skillSelection` (`skillScope`), not as a list, so the picker draws its
 * members from the Library list it already loaded: every row that can be
 * pinned. Unchecking one member turns the scope into a fixed list of the
 * others, which the selection cap then has to fit.
 */
import { Library } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@/lib/utils";

/** What a picker that offers the choice needs from its caller. */
export type AllLibraryChoice = {
  /** On for every environment, for some of them, or for none. */
  state: boolean | "partial";
  /** Turns the scope on or off on every environment. */
  onToggle: (on: boolean) => void;
  /**
   * One member unchecked: where the scope is on, `rest` becomes a fixed list;
   * elsewhere the skill is removed.
   */
  onLeaveOut: (skillId: string, rest: string[]) => void;
  /**
   * The most MCP-server skills an environment on the scope selects. A fixed
   * list shares the selection cap with them.
   */
  serverSkillCount: number;
};

/**
 * A Library row's check state when the scope can stand in for its members:
 * an environment on the scope runs every member at Latest, and no other
 * Library skill.
 */
export function scopedRowState(
  scope: AllLibraryChoice["state"],
  member: boolean,
  own: { checked: boolean; partial: boolean; pinned: boolean },
): { checked: boolean; partial: boolean } {
  if (scope === false) {
    return { checked: own.checked, partial: !own.checked && own.partial };
  }
  if (scope === true) {
    return member
      ? { checked: true, partial: false }
      : { checked: false, partial: own.checked || own.partial };
  }
  // Some environments are on the scope. A member is on everywhere only when
  // every other environment selects it at Latest too.
  const everywhere = member && own.checked && !own.pinned;
  return {
    checked: everywhere,
    partial: !everywhere && (member || own.checked || own.partial),
  };
}

/** The line under the choice: what it does, or why a member can't be unchecked. */
export function allLibraryNote({
  state,
  leaveOutTotal,
  limit,
  narrowed,
}: {
  state: AllLibraryChoice["state"];
  /** Skills a fixed list would hold once one member is left out. */
  leaveOutTotal: number;
  limit: number;
  /** A member was unchecked while this picker was open. */
  narrowed: boolean;
}): string {
  if (state === true && leaveOutTotal > limit) {
    return `Leaving one out would make a list of ${leaveOutTotal} skills, over the limit of ${limit}. Turn this off to pick skills one by one.`;
  }
  if (state === true) {
    return "New Library skills join future runs. Uncheck one to keep the others as a fixed list.";
  }
  if (narrowed && state === false) {
    return "Changed to a fixed list. New Library skills won’t join future runs.";
  }
  return "Runs get each skill’s latest version, and new Library skills join future runs.";
}

export function AllLibrarySkillsRow({
  state,
  note,
  disabled,
  onToggle,
}: {
  state: AllLibraryChoice["state"];
  note: string;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
      )}
    >
      <Checkbox
        checked={state === "partial" ? "indeterminate" : state}
        // A partly-on click means "on", as on every other row.
        onCheckedChange={(next) => onToggle(next === true)}
        disabled={disabled}
        aria-label="All shared Library skills"
      />
      <Library className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="font-normal">All shared Library skills</span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          {note}
        </span>
      </span>
    </Label>
  );
}
