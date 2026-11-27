/**
 * The Skills field's two channels beside Library picks: MCP-server skills
 * and the "All shared Library skills" scope. As with Library picks
 * (`suite-skills.ts`), a picker click becomes one change per environment,
 * made to that environment's own fields.
 */
import type { SkillSelectionEdit } from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
import type {
  ProjectEnvironmentServerSkillSelection,
  ProjectEnvironmentSkillScope,
  ProjectEnvironmentSkillSelection,
} from "@/hooks/useProjectEnvironments";
import {
  editedSkillSelection,
  selectedSkillCount,
  sharedPicks,
  suiteSkillState,
  type SuiteSkillsChange,
  type SuiteSkillsSource,
} from "./suite-skills";

export const ALL_SHARED_LIBRARY: ProjectEnvironmentSkillScope =
  "all-shared-library";

/** A server-skill selection in a Library selection's shape, to reuse its rules. */
function asLibrary(
  selection: ProjectEnvironmentServerSkillSelection | null | undefined,
): ProjectEnvironmentSkillSelection | null {
  if (!selection) return null;
  const pins = selection.versionPins?.map((pin) => ({
    skillId: pin.serverSkillId,
    versionId: pin.versionId,
  }));
  return {
    mode: "explicit",
    skillIds: selection.serverSkillIds,
    ...(pins?.length ? { versionPins: pins } : {}),
  };
}

function asServer(
  selection: ProjectEnvironmentSkillSelection,
): ProjectEnvironmentServerSkillSelection {
  const pins = selection.versionPins?.map((pin) => ({
    serverSkillId: pin.skillId,
    versionId: pin.versionId,
  }));
  return {
    mode: "explicit",
    serverSkillIds: selection.skillIds,
    ...(pins?.length ? { versionPins: pins } : {}),
  };
}

/** Server skills every environment selects, and what the picker needs. */
export function serverSkillState(environments: readonly SuiteSkillsSource[]) {
  const { value, across } = sharedPicks(
    environments.map((row) => asLibrary(row.serverSkillSelection)),
    environments.map(selectedSkillCount),
  );
  return { value: value && asServer(value), across };
}

/** The same rules as a Library selection: Latest on add, `null` clears. */
export function editedServerSkillSelection(
  selection: ProjectEnvironmentServerSkillSelection | null | undefined,
  edit: SkillSelectionEdit,
): ProjectEnvironmentServerSkillSelection | null | undefined {
  const next = editedSkillSelection(asLibrary(selection), edit);
  return next ? asServer(next) : next;
}

/** On for every environment, for some of them, or for none. */
export function skillScopeState(
  environments: readonly SuiteSkillsSource[],
): boolean | "partial" {
  const on = environments.filter((row) => row.skillScope).length;
  if (on === 0) return false;
  return on === environments.length ? true : "partial";
}

/** The most server skills an environment on the scope selects. */
export function scopedServerSkillCount(
  environments: readonly SuiteSkillsSource[],
): number {
  return Math.max(
    0,
    ...environments.flatMap((row) =>
      row.skillScope
        ? [row.serverSkillSelection?.serverSkillIds.length ?? 0]
        : [],
    ),
  );
}

/** Whether the environments differ in any skill, version or scope. */
export function suiteSkillsMixed(
  environments: readonly SuiteSkillsSource[],
): boolean {
  return (
    suiteSkillState(environments).across.partialIds.size > 0 ||
    serverSkillState(environments).across.partialIds.size > 0 ||
    skillScopeState(environments) === "partial"
  );
}

/**
 * A Library pick. An environment on the scope already runs every shared
 * skill at Latest, so a pick leaves it alone.
 */
export function libraryChange(
  row: SuiteSkillsSource,
  edit: SkillSelectionEdit,
): SuiteSkillsChange | undefined {
  if (row.skillScope) return undefined;
  const skillSelection = editedSkillSelection(row.skillSelection, edit);
  return skillSelection === undefined ? undefined : { skillSelection };
}

export function serverChange(
  row: SuiteSkillsSource,
  edit: SkillSelectionEdit,
): SuiteSkillsChange | undefined {
  const serverSkillSelection = editedServerSkillSelection(
    row.serverSkillSelection,
    edit,
  );
  return serverSkillSelection === undefined
    ? undefined
    : { serverSkillSelection };
}

/**
 * The scope turned on or off. On replaces the Library list and its pins,
 * because the scope always runs Latest; the backend refuses both at once.
 */
export function scopeChange(
  row: SuiteSkillsSource,
  on: boolean,
): SuiteSkillsChange | undefined {
  if (Boolean(row.skillScope) === on) return undefined;
  return on
    ? { skillScope: ALL_SHARED_LIBRARY, skillSelection: null }
    : { skillScope: null };
}

/**
 * One Library skill unchecked while the scope is on somewhere: on the scope,
 * the other members become a fixed list; elsewhere the skill is removed.
 */
export function leftOutChange(
  row: SuiteSkillsSource,
  skillId: string,
  rest: readonly string[],
): SuiteSkillsChange | undefined {
  if (!row.skillScope) return libraryChange(row, { kind: "remove", skillId });
  return {
    skillScope: null,
    skillSelection: rest.length
      ? { mode: "explicit", skillIds: [...rest] }
      : null,
  };
}
