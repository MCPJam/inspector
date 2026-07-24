import { useEffect, useMemo, useState } from "react";
import { Loader2, SquareSlash } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { listSkills } from "@/lib/apis/mcp-skills-api";
import type { SkillListItem } from "@/shared/skill-types";
import type { ProjectEnvironmentSkillSelection } from "@/hooks/useProjectEnvironments";

/** Backend cap on `skillSelection.skillIds`. */
export const MAX_ENVIRONMENT_SKILLS = 20;

/**
 * Shared-skill multi-select for a project environment's `skillSelection`.
 *
 * Only SHARED (`sharing === 'project'`) skills are selectable — the backend
 * rejects personal skills. Rows the backend flags as non-pinnable (P0.3
 * `pinnability` metadata: plugin_component skills, supporting files, extra
 * frontmatter) render disabled with the backend-aligned reason, so users
 * never pick a skill only to discover the restriction at save time.
 *
 * Emits `{ mode: 'explicit', skillIds }` or `null` — never an empty array
 * (the backend rejects `[]`; clearing means `null`).
 */
export function ProjectEnvironmentSkillsPicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  value: ProjectEnvironmentSkillSelection | null | undefined;
  onChange: (next: ProjectEnvironmentSkillSelection | null) => void;
  disabled?: boolean;
}) {
  const [skills, setSkills] = useState<SkillListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSkills(null);
    setLoadError(null);
    (async () => {
      try {
        const list = await listSkills({ kind: "cloud", projectId });
        if (!active) return;
        setSkills(list.filter((s) => s.sharing === "project" && s.skillId));
      } catch (err) {
        if (!active) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load skills"
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const selectedIds = useMemo(() => new Set(value?.skillIds ?? []), [value]);
  const atCap = selectedIds.size >= MAX_ENVIRONMENT_SKILLS;

  const toggle = (skillId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      if (next.size >= MAX_ENVIRONMENT_SKILLS) return;
      next.add(skillId);
    } else {
      next.delete(skillId);
    }
    // Never emit an empty explicit selection — clearing means null.
    onChange(
      next.size === 0 ? null : { mode: "explicit", skillIds: Array.from(next) }
    );
  };

  if (loadError) {
    return (
      <p className="text-xs text-destructive">
        Couldn&apos;t load project skills: {loadError}
      </p>
    );
  }
  if (skills === null) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading skills…
      </div>
    );
  }
  if (skills.length === 0) {
    return (
      <p className="py-1 text-xs italic text-muted-foreground">
        No shared skills in this project yet. Share a skill with the project to
        pin it here.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div
        role="group"
        aria-label="Environment skills"
        className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1"
      >
        {skills.map((skill) => {
          const skillId = skill.skillId!;
          const checked = selectedIds.has(skillId);
          const ineligible =
            skill.pinnability !== undefined && skill.pinnability.ok === false;
          const capBlocked = !checked && atCap;
          // Ineligibility (and the cap) block NEW selections only — a skill that
          // was pinned and later became ineligible must stay uncheckable so the
          // user can repair the selection.
          const rowDisabled =
            disabled || capBlocked || (ineligible && !checked);
          const row = (
            <Label
              key={skillId}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30",
                rowDisabled &&
                  "cursor-not-allowed opacity-60 hover:bg-transparent"
              )}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) => toggle(skillId, next === true)}
                disabled={rowDisabled}
                aria-label={skill.name}
              />
              <SquareSlash className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-normal">{skill.name}</span>
                {skill.description ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {skill.description}
                  </span>
                ) : null}
              </span>
            </Label>
          );
          if (!ineligible) return row;
          return (
            <Tooltip key={skillId}>
              <TooltipTrigger asChild>
                {/* span keeps the tooltip alive over the disabled row */}
                <span>{row}</span>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[260px]">
                <p className="text-xs leading-snug">
                  {skill.pinnability && !skill.pinnability.ok
                    ? skill.pinnability.reason
                    : "This skill can't be pinned to an environment."}
                </p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {selectedIds.size}/{MAX_ENVIRONMENT_SKILLS} skills selected
        {atCap ? " — cap reached" : ""}. Shared skills only.
      </p>
    </div>
  );
}
