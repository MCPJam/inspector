import { useEffect, useMemo, useState } from "react";
import { Loader2, SquareSlash } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@/lib/utils";
import {
  listSkills,
  listSkillVersions,
  type CloudSkillVersionSummary,
} from "@/lib/apis/mcp-skills-api";
import type { SkillListItem } from "@/shared/skill-types";
import type { ProjectEnvironmentSkillSelection } from "@/hooks/useProjectEnvironments";

/** Backend cap on `skillSelection.skillIds`. */
export const MAX_ENVIRONMENT_SKILLS = 20;

/**
 * Why a listed skill can't be pinned, in the reader's words.
 *
 * The backend `reason` is an enum meant for callers (`not_shared`,
 * `plugin_component`), and it used to be rendered raw. That was survivable
 * while only exotic rows were ineligible; now that every personal skill is
 * listed, the most common disabled row in the picker would read "not_shared".
 *
 * Unknown reasons fall through to the generic line rather than leaking an
 * identifier: this list grows on the backend, and a picker on an older client
 * should say something true rather than something internal.
 */
/**
 * Why this skill can't be pinned, or `null` if it can.
 *
 * `pinnability` is OPTIONAL on the wire — absent on a backend older than P0.3
 * — so it cannot be the only thing consulted. That was harmless while personal
 * skills were filtered out client-side and every remaining row was already
 * eligible; now that they are listed, a row with no metadata would render as
 * selectable, and the save would be the first the user heard of it.
 *
 * Shared-only is the one rule this picker can evaluate for itself, from a
 * field that is not optional, so it is checked independently. The backend's
 * own verdict still wins when it is present — it knows about restrictions
 * (plugin components) this client cannot see.
 */
function pinRejection(skill: SkillListItem): string | null {
  if (skill.pinnability && !skill.pinnability.ok)
    return skill.pinnability.reason;
  if (skill.sharing !== "project") return "not_shared";
  return null;
}

function ineligibleReason(reason: string | undefined): string {
  switch (reason) {
    case "not_shared":
      return "Personal skill — only skills in the project library can run in environments. An admin can publish it.";
    case "plugin_component":
      return "Delivered by its plugin, not pinned on its own. Pin the plugin version instead.";
    default:
      return "This skill can't be pinned to an environment.";
  }
}

/**
 * Library-skill multi-select for a project environment's `skillSelection`.
 *
 * Only skills in the project LIBRARY (`sharing === 'project'`) can be pinned —
 * the backend rejects personal ones, because an environment a teammate runs
 * must resolve to the same skills for them as for you.
 *
 * Personal skills are nonetheless LISTED, disabled, with the reason on the row.
 * Filtering them out client-side made the picker lie by omission: a user who
 * had just uploaded a skill and came here to pin it found no trace of it and
 * no way to tell whether it had failed to upload, been named something else,
 * or simply wasn't eligible. The backend already says which of those it is —
 * every listed row carries P0.3 `pinnability` metadata — so the picker shows
 * the row and quotes the reason.
 *
 * The same machinery covers every other ineligible row (plugin_component
 * skills), so users never pick a skill only to discover the restriction at
 * save time.
 *
 * Each selected skill also gets a VERSION control, defaulting to "Latest" —
 * the skill's current revision, resolved when the run starts, which is what an
 * environment has always done. Choosing an exact revision writes a
 * `versionPins` entry, which is how two environments run two revisions of one
 * skill side by side. History is fetched only when a control is opened: a
 * picker listing 20 skills should not fetch 20 histories nobody looked at.
 *
 * Emits `{ mode: 'explicit', skillIds, versionPins? }` or `null` — never an
 * empty array (the backend rejects `[]`; clearing means `null`), and
 * `versionPins` is omitted rather than `[]` when nothing is pinned, so an
 * unpinned environment serializes exactly as it did before pins existed.
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
        // `skillId` is the only hard requirement — it is what a pin addresses.
        // Library skills sort first: they are the ones that can be picked, and
        // a picker that opens on a wall of disabled rows reads as broken.
        const pinnable = list.filter((s) => s.skillId);
        pinnable.sort((a, b) => {
          const aLib = a.sharing === "project" ? 0 : 1;
          const bLib = b.sharing === "project" ? 0 : 1;
          return aLib - bLib;
        });
        setSkills(pinnable);
      } catch (err) {
        if (!active) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load skills",
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const selectedIds = useMemo(() => new Set(value?.skillIds ?? []), [value]);
  const pinnedVersionBySkillId = useMemo(
    () =>
      new Map((value?.versionPins ?? []).map((p) => [p.skillId, p.versionId])),
    [value],
  );
  const atCap = selectedIds.size >= MAX_ENVIRONMENT_SKILLS;
  // Pinned ids the shared-skills list doesn't return: the skill was unshared,
  // deleted, or moved out of the project. Without a row they are invisible AND
  // unremovable, yet they still count toward the footer and still ship on
  // save. Surface them as detach-only rows. Gated on `skills` having loaded so
  // the loading state doesn't flash every pin as an orphan.
  const orphanSelectedIds = useMemo(
    () =>
      skills === null
        ? []
        : Array.from(selectedIds).filter(
            (id) => !skills.some((s) => s.skillId === id),
          ),
    [skills, selectedIds],
  );

  /** Emit a selection, dropping pins for skills that are no longer selected. */
  const emit = (nextIds: Set<string>, nextPins: Map<string, string>): void => {
    // Never emit an empty explicit selection — clearing means null.
    if (nextIds.size === 0) {
      onChange(null);
      return;
    }
    const pins = Array.from(nextPins.entries())
      // A pin for an unselected skill is rejected by the backend, and would be
      // a silent passenger even if it weren't.
      .filter(([skillId]) => nextIds.has(skillId))
      .map(([skillId, versionId]) => ({ skillId, versionId }));
    onChange({
      mode: "explicit",
      skillIds: Array.from(nextIds),
      // Absent, not `[]`, when nothing is pinned.
      ...(pins.length > 0 ? { versionPins: pins } : {}),
    });
  };

  const toggle = (skillId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      if (next.size >= MAX_ENVIRONMENT_SKILLS) return;
      next.add(skillId);
    } else {
      next.delete(skillId);
    }
    emit(next, pinnedVersionBySkillId);
  };

  /** Pin one skill to an exact revision, or `null` to go back to Latest. */
  const setVersionPin = (skillId: string, versionId: string | null) => {
    const nextPins = new Map(pinnedVersionBySkillId);
    if (versionId === null) nextPins.delete(skillId);
    else nextPins.set(skillId, versionId);
    emit(selectedIds, nextPins);
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
  // Only the truly-empty case short-circuits. With orphaned pins we MUST fall
  // through to the list so they get detach-only rows — otherwise the pins are
  // invisible, unremovable, and still sent on save.
  if (skills.length === 0 && orphanSelectedIds.length === 0) {
    return (
      <p className="py-1 text-xs italic text-muted-foreground">
        No skills in the project library yet. Add a skill to the library to pin
        it here.
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
          const rejection = pinRejection(skill);
          const ineligible = rejection !== null;
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
                  "cursor-not-allowed opacity-60 hover:bg-transparent",
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
                {/* An ineligible row shows WHY, in place of its description.
                    The reason used to live only in a tooltip, and a tooltip is
                    not reachable here: the trigger wraps a row whose only
                    focusable control is a DISABLED checkbox, so a keyboard or
                    screen-reader user met a greyed-out row with no stated
                    cause. It is also the more useful line — a reader scanning
                    a disabled row wants the restriction, not the blurb. */}
                {ineligible ? (
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {ineligibleReason(rejection ?? undefined)}
                  </span>
                ) : skill.description ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {skill.description}
                  </span>
                ) : null}
              </span>
              {checked ? (
                <SkillVersionControl
                  projectId={projectId}
                  skillId={skillId}
                  currentVersionNumber={skill.currentVersionNumber}
                  pinnedVersionId={pinnedVersionBySkillId.get(skillId) ?? null}
                  // An ineligible skill's selection is rejected at save, so
                  // choosing a revision for it leads nowhere. The row's
                  // checkbox stays enabled (see `rowDisabled`) precisely so the
                  // user can repair the selection by removing it.
                  disabled={disabled || ineligible}
                  onChange={(versionId) => setVersionPin(skillId, versionId)}
                />
              ) : null}
            </Label>
          );
          return row;
        })}
        {orphanSelectedIds.map((skillId) => (
          <Label
            key={skillId}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30",
              disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
            )}
          >
            {/* Unresolvable pin: uncheck to remove only — never re-selectable.
                There is no name to show; the row exists so the id is
                removable rather than a silent passenger on every save. */}
            <Checkbox
              checked
              onCheckedChange={() => toggle(skillId, false)}
              disabled={disabled}
              aria-label={`Unavailable skill ${skillId} (remove)`}
            />
            <SquareSlash className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-normal text-muted-foreground">
                Unavailable skill
                <span className="ml-1 font-mono text-[10px]">
                  {skillId.slice(0, 8)}
                </span>
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                No longer in the project library — remove it to save.
              </span>
            </span>
          </Label>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {selectedIds.size}/{MAX_ENVIRONMENT_SKILLS} skills selected
        {pinnedVersionBySkillId.size > 0
          ? ` (${pinnedVersionBySkillId.size} pinned to a version)`
          : ""}
        {atCap ? " — cap reached" : ""}. Library skills only.
      </p>
    </div>
  );
}

/**
 * "Latest" vs an exact revision, for ONE selected skill.
 *
 * History loads on first open, not on mount: a picker showing 20 skills would
 * otherwise fire 20 requests for lists nobody looked at. Until then the control
 * shows what it already knows from the list row — the current version number.
 *
 * Latest is the default and stays the default. Pinning is the deliberate act
 * (hold this environment at a known revision so a comparison means something),
 * so it is never selected on the user's behalf.
 */
function SkillVersionControl({
  projectId,
  skillId,
  currentVersionNumber,
  pinnedVersionId,
  disabled,
  onChange,
}: {
  projectId: string;
  skillId: string;
  currentVersionNumber?: number;
  pinnedVersionId: string | null;
  disabled: boolean;
  onChange: (versionId: string | null) => void;
}) {
  const [versions, setVersions] = useState<CloudSkillVersionSummary[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);

  const loadVersions = async () => {
    if (versions !== null || loading) return;
    setLoading(true);
    try {
      setVersions(await listSkillVersions(projectId, skillId));
    } catch {
      // A failed history load must not block the selection itself: fall back
      // to an empty list, which renders as "Latest only".
      setVersions([]);
    } finally {
      setLoading(false);
    }
  };

  // What the trigger says before history arrives: the pinned number when we
  // know it, else Latest (with its number when the list row carried one).
  const pinned = versions?.find((v) => v.versionId === pinnedVersionId);
  const label = pinnedVersionId
    ? pinned
      ? `v${pinned.versionNumber}`
      : "Pinned"
    : currentVersionNumber !== undefined
    ? `Latest (v${currentVersionNumber})`
    : "Latest";

  return (
    <select
      // eslint-disable-next-line jsx-a11y/no-onchange
      className={cn(
        "ml-auto shrink-0 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px]",
        pinnedVersionId && "border-warning/60",
      )}
      aria-label={`Version for ${skillId}`}
      disabled={disabled}
      value={pinnedVersionId ?? ""}
      onMouseDown={(e) => {
        // Opening the control is what triggers the fetch; stop the click from
        // reaching the row Label, which would toggle the checkbox.
        e.stopPropagation();
        void loadVersions();
      }}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => void loadVersions()}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    >
      <option value="">{label === "Pinned" ? "Latest" : label}</option>
      {loading ? <option disabled>Loading…</option> : null}
      {(versions ?? []).map((version) => (
        <option key={version.versionId} value={version.versionId}>
          v{version.versionNumber}
          {version.isCurrent ? " (current)" : ""}
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
