/**
 * Skills slot — same dashed-pill / popover language as the other slots. The
 * empty-state copy stays inside the popover so the strip never grows an italic
 * paragraph.
 */
import { useState } from "react";
import { ChevronDown, SquareSlash } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  ProjectEnvironmentSkillsPicker,
  type SkillSelectionAcross,
  type SkillSelectionEdit,
} from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
import type { AllLibraryChoice } from "@/components/project-environments/all-library-skills";
import type { ServerSkillsChoice } from "@/components/project-environments/server-skills-section";
import type { ProjectEnvironmentSkillSelection } from "@/hooks/useProjectEnvironments";
import { cn } from "@/lib/utils";

export function SkillsPill({
  projectId,
  value,
  onChange,
  disabled,
  testId,
  inModal = false,
  variant = "pill",
  readOnly = false,
  notice,
  across,
  allLibrary,
  serverSkills,
}: {
  projectId: string;
  value: ProjectEnvironmentSkillSelection | null;
  onChange: (
    next: ProjectEnvironmentSkillSelection | null,
    edit: SkillSelectionEdit,
  ) => void;
  disabled?: boolean;
  testId?: string;
  /**
   * Render the popover INLINE rather than portalled, for callers inside a Radix
   * Dialog — a portalled popover lands outside the dialog, where the modal
   * overlay swallows every click. Same escape hatch, same name, as
   * `EnvironmentPicker` and `ServerPicker`.
   */
  inModal?: boolean;
  /**
   * Shape only, as on `ServerPicker`: `field` lines up with the other fields
   * in a labelled row, where a pill would read as a different control.
   */
  variant?: "pill" | "field";
  /** Opens to show what is selected, with nothing in it that changes it. */
  readOnly?: boolean;
  /** One line above the list: why it is read only, or what a click does. */
  notice?: string;
  across?: SkillSelectionAcross;
  allLibrary?: AllLibraryChoice;
  serverSkills?: ServerSkillsChoice;
}) {
  const [open, setOpen] = useState(false);
  const field = variant === "field";
  const mixed =
    (across?.partialIds.size ?? 0) > 0 ||
    (serverSkills?.across.partialIds.size ?? 0) > 0 ||
    allLibrary?.state === "partial";
  const serverCount = serverSkills?.value?.serverSkillIds.length ?? 0;
  const selectedCount = (value?.skillIds.length ?? 0) + serverCount;
  const triggerLabel = mixed
    ? "Mixed skills"
    : allLibrary?.state === true
      ? serverCount
        ? `All shared Library skills + ${serverCount}`
        : "All shared Library skills"
      : selectedCount === 0
        ? field
          ? "No skills"
          : "No skills · pick some"
        : selectedCount === 1
          ? "1 skill"
          : `${selectedCount} skills`;

  return (
    <Popover open={open} onOpenChange={(next) => {
        // CLOSE always goes through, even when disabled: a menu open at the
        // moment the strip becomes disabled (a commit starting) would otherwise
        // be stuck open with no way out.
        if (!next || !disabled) setOpen(next);
      }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          aria-label="Skills"
          className={cn(
            "flex items-center text-foreground outline-none transition-colors",
            field
              ? "h-9 w-full gap-1.5 rounded-md border border-input bg-transparent px-3 shadow-xs hover:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              : selectedCount === 0
                ? "h-8 max-w-[260px] shrink-0 gap-1 rounded-full border border-dashed border-border/60 bg-muted/30 px-2 hover:bg-muted/45"
                : "h-8 max-w-[260px] shrink-0 gap-1 rounded-full border border-border/60 bg-muted/40 px-2 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <SquareSlash
            className={cn(
              "shrink-0 text-muted-foreground",
              field ? "size-4" : "size-3.5",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              field
                ? cn(
                    "text-left text-sm",
                    selectedCount === 0 &&
                      !mixed &&
                      allLibrary?.state !== true &&
                      "text-muted-foreground",
                  )
                : "text-xs font-medium",
            )}
          >
            {triggerLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        // A field's rows carry server badges and version menus.
        className={cn("p-2", field ? "w-96" : "w-72")}
        align="start"
        sideOffset={4}
        portalled={!inModal}
      >
        <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Skills · library pins
        </div>
        {notice ? (
          <p className="px-1 pb-2 text-xs text-muted-foreground">{notice}</p>
        ) : null}
        <ProjectEnvironmentSkillsPicker
          projectId={projectId}
          value={value}
          onChange={onChange}
          disabled={disabled || readOnly}
          across={across}
          allLibrary={allLibrary}
          serverSkills={serverSkills}
        />
      </PopoverContent>
    </Popover>
  );
}
