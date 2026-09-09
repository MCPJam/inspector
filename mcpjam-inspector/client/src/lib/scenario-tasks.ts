import type { ScenarioTaskItem, ScenarioTasksSettings } from "@/types/chatUi";

/**
 * "What to try" — the study's task list, shared by the three surfaces that
 * touch it: create step 2, the study's settings, and the tester's checklist.
 *
 * The list is the whole feature. Nothing here sequences a tester, gates the
 * composer, or reports completion back to the creator: check state is local to
 * the tester's tab, and what they actually did is read from Sessions. Keeping
 * that rule in one module is why "not a wizard" survives the next change to
 * any of the three surfaces.
 */

/**
 * Mirrors `SCENARIO_TASK_LIMIT` in the backend's `scenarioUxValidators`.
 *
 * Duplicated rather than imported because the two repos deploy separately —
 * the editor stops offering "Add a task" here, and the backend normalizer caps
 * the write regardless of which client sent it.
 */
export const SCENARIO_TASK_LIMIT = 5;
export const SCENARIO_TASK_TITLE_MAX = 200;
export const SCENARIO_TASK_HINT_MAX = 280;

/** An editor row: same shape as a stored task, but the title may be empty. */
export interface ScenarioTaskDraft {
  id: string;
  title: string;
  hint: string;
}

let draftCounter = 0;

/**
 * A fresh row id, unique within this tab.
 *
 * Only has to be unique among the rows the editor is holding — the backend
 * normalizer repairs blanks and collisions from any writer — so a counter plus
 * the clock beats pulling in a uuid dependency for a list capped at five.
 */
export function mintScenarioTaskId(): string {
  draftCounter += 1;
  return `task-${Date.now().toString(36)}-${draftCounter.toString(36)}`;
}

export function emptyScenarioTaskDraft(): ScenarioTaskDraft {
  return { id: mintScenarioTaskId(), title: "", hint: "" };
}

/**
 * Stored list → editor rows.
 *
 * Tolerates a backend that predates this surface (`tasks` absent) and a
 * `tasks` object whose `items` is missing, because redeem and the settings
 * response both come from a deployment this build does not control.
 */
export function scenarioTaskDraftsFromSettings(
  tasks: ScenarioTasksSettings | null | undefined,
): ScenarioTaskDraft[] {
  const items = Array.isArray(tasks?.items) ? tasks.items : [];
  return items.map((item) => ({
    id: item.id || mintScenarioTaskId(),
    title: item.title ?? "",
    hint: item.hint ?? "",
  }));
}

/**
 * Editor rows → the list to persist.
 *
 * Blank rows are DROPPED rather than rejected: an empty trailing row is how
 * the editor offers the next task, and pressing Save with one open should not
 * be an error the creator has to clear. `hint` is omitted when empty so a
 * stored task carries the key only when it means something.
 */
export function scenarioTasksFromDrafts(
  drafts: readonly ScenarioTaskDraft[],
): ScenarioTaskItem[] {
  const items: ScenarioTaskItem[] = [];
  for (const draft of drafts) {
    if (items.length >= SCENARIO_TASK_LIMIT) break;
    const title = draft.title.trim().slice(0, SCENARIO_TASK_TITLE_MAX);
    if (!title) continue;
    const hint = draft.hint.trim().slice(0, SCENARIO_TASK_HINT_MAX);
    items.push({ id: draft.id, title, ...(hint ? { hint } : {}) });
  }
  return items;
}

/** Whether these two lists would persist identically — used to skip no-op writes. */
export function scenarioTasksEqual(
  a: readonly ScenarioTaskItem[],
  b: readonly ScenarioTaskItem[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      item.id === other.id &&
      item.title === other.title &&
      (item.hint ?? "") === (other.hint ?? "")
    );
  });
}

/**
 * The count on the tester's control: what is LEFT, not how many there are.
 *
 * A tester reads this to decide whether to keep going, and "3 of 5" makes them
 * do the subtraction. `Done` rather than `0 left` because zero-of-anything
 * reads as an error state.
 */
export function scenarioTasksRemainingLabel(
  total: number,
  completed: number,
): string {
  const remaining = Math.max(0, total - completed);
  return remaining === 0 ? "Done" : `${remaining} left`;
}

export function scenarioTaskCheckStorageKey(scenarioId: string): string {
  return `scenario-tasks-checked-${scenarioId}`;
}

/**
 * The tester's checked items, per study, for this tab.
 *
 * `sessionStorage`, matching `scenarioIntroDismissedStorageKey`: the unit is
 * one tester session, so a reload keeps the checkmarks and a new tab starts
 * clean. Never sent anywhere — see the module note.
 *
 * Every access is guarded: a tester in a private window (or with site data
 * blocked) must get a working checklist, just one that forgets.
 */
export function readScenarioTaskChecks(scenarioId: string): string[] {
  try {
    const raw = sessionStorage.getItem(scenarioTaskCheckStorageKey(scenarioId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeScenarioTaskChecks(
  scenarioId: string,
  checkedIds: readonly string[],
): void {
  try {
    sessionStorage.setItem(
      scenarioTaskCheckStorageKey(scenarioId),
      JSON.stringify([...checkedIds]),
    );
  } catch {
    // A tester who cannot persist still gets a checklist for this page view.
  }
}
