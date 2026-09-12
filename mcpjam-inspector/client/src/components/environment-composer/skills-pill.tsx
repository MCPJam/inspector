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
import { ProjectEnvironmentSkillsPicker } from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
import type { ProjectEnvironmentSkillSelection } from "@/hooks/useProjectEnvironments";
import { cn } from "@/lib/utils";

export function SkillsPill({
  projectId,
  value,
  onChange,
  disabled,
  testId,
  inModal = false,
}: {
  projectId: string;
  value: ProjectEnvironmentSkillSelection | null;
  onChange: (next: ProjectEnvironmentSkillSelection | null) => void;
  disabled?: boolean;
  testId?: string;
  /**
   * Render the popover INLINE rather than portalled, for callers inside a Radix
   * Dialog — a portalled popover lands outside the dialog, where the modal
   * overlay swallows every click. Same escape hatch, same name, as
   * `EnvironmentPicker` and `ServerPicker`.
   */
  inModal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedCount = value?.skillIds.length ?? 0;
  const triggerLabel =
    selectedCount === 0
      ? "No skills · pick some"
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
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            selectedCount === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <SquareSlash className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        align="start"
        sideOffset={4}
        portalled={!inModal}
      >
        <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Skills · library pins
        </div>
        <ProjectEnvironmentSkillsPicker
          projectId={projectId}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      </PopoverContent>
    </Popover>
  );
}
