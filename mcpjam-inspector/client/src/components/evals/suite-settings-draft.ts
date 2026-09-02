/**
 * The settings sheet's unsaved state, as a pure reducer.
 *
 * WHAT CHANGED AND WHY. Every control in the sheet used to write on change:
 * a dropdown, a toggle, a debounced text field, each firing its own mutation
 * and its own toast. Three consequences, all of them things people reported
 * rather than things we predicted:
 *
 *   - **No way to not save.** There was no Cancel, because there was nothing
 *     uncommitted to cancel. Reading a setting meant risking changing it.
 *   - **No unit of change.** A person adjusting four related settings produced
 *     four writes, four toasts and four points in the suite's history, none of
 *     which is the change they made.
 *   - **Silent clobbering.** Two people (or two tabs) editing the same suite
 *     each saw their own write succeed. Last write won, and neither was told.
 *
 * The draft fixes all three by being the thing that is edited, with the save
 * as a separate, deliberate act. This module holds only the STATE and the
 * arithmetic on it; the mutation lives in `use-suite-settings-draft.ts` and
 * the UI in the sheet.
 *
 * It is deliberately pure and total. Every selector is defined for every key,
 * so a new setting cannot render as a change nobody can describe.
 */

import type { EvalMatchOptions } from "@/shared/eval-matching";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { ORDER_OPTIONS, ARGS_OPTIONS } from "./validators-section";
import type { EvalJudgeConfig, EvalJudgeRubric } from "./types";

/**
 * The fields the sheet drafts.
 *
 * Everything here is EXECUTION configuration: what a run would do. The rows
 * that stay immediate writers — environments, schedule, host attachments — are
 * absent on purpose, and the sheet labels them as saving immediately, because
 * each has its own cross-field validation that a batched save would have to
 * re-implement.
 */
export type SuiteSettingsValues = {
  name: string;
  defaultPassCriteria: { minimumPassRate: number } | undefined;
  minIterations: number | undefined;
  computerEnvironmentId: string | undefined;
  defaultMatchOptions: EvalMatchOptions | undefined;
  defaultPredicates: Predicate[];
  judgeConfig: EvalJudgeConfig | undefined;
  judgeRubric: EvalJudgeRubric | undefined;
};

export type SuiteSettingsKey = keyof SuiteSettingsValues;

export const SUITE_SETTINGS_KEYS: readonly SuiteSettingsKey[] = [
  "name",
  "defaultPassCriteria",
  "minIterations",
  "computerEnvironmentId",
  "defaultMatchOptions",
  "defaultPredicates",
  "judgeConfig",
  "judgeRubric",
];

export type SuiteSettingsDraft = {
  /** What the server had when this draft was last rebased or committed. */
  base: SuiteSettingsValues;
  /** What the person has now. */
  current: SuiteSettingsValues;
  /**
   * Keys the SERVER moved while the person held an unsaved edit on them.
   *
   * Not an error state and not a merge: it is the set of fields where two
   * people made different decisions, which is the one thing an automatic
   * resolution cannot choose between. The sheet marks them and lets the person
   * decide, which is slower and correct.
   */
  conflicts: SuiteSettingsKey[];
};

export type SuiteSettingsAction =
  | { type: "edit"; key: SuiteSettingsKey; value: unknown }
  | { type: "discard" }
  | { type: "rebase"; live: SuiteSettingsValues }
  | { type: "commitSucceeded"; live: SuiteSettingsValues };

/** Structural equality over draft values. Order-sensitive for lists, deliberately. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read a suite document into the draft's value shape. */
export function readSuiteSettingsValues(suite: {
  name?: string;
  defaultPassCriteria?: { minimumPassRate?: number };
  minIterations?: number;
  environment?: { computerEnvironmentId?: string };
  defaultMatchOptions?: EvalMatchOptions;
  defaultPredicates?: Predicate[];
  judgeConfig?: EvalJudgeConfig;
  judgeRubric?: EvalJudgeRubric;
}): SuiteSettingsValues {
  return {
    name: suite.name ?? "",
    defaultPassCriteria:
      suite.defaultPassCriteria?.minimumPassRate === undefined
        ? undefined
        : { minimumPassRate: suite.defaultPassCriteria.minimumPassRate },
    minIterations: suite.minIterations,
    computerEnvironmentId: suite.environment?.computerEnvironmentId,
    defaultMatchOptions: suite.defaultMatchOptions,
    // Normalized to a list so "no checks" has ONE spelling in the draft.
    // Absent and empty are the same state to a reader, and two spellings is
    // how one of them ends up looking like an unsaved change.
    defaultPredicates: suite.defaultPredicates ?? [],
    judgeConfig: suite.judgeConfig,
    judgeRubric: suite.judgeRubric,
  };
}

export function initSuiteSettingsDraft(
  values: SuiteSettingsValues
): SuiteSettingsDraft {
  return { base: values, current: values, conflicts: [] };
}

export function suiteSettingsReducer(
  state: SuiteSettingsDraft,
  action: SuiteSettingsAction
): SuiteSettingsDraft {
  switch (action.type) {
    case "edit": {
      const current = {
        ...state.current,
        [action.key]: action.value,
      } as SuiteSettingsValues;
      return {
        ...state,
        current,
        // Editing a conflicted key IS the person's decision about it, so the
        // marker clears. Leaving it would keep warning them about a
        // disagreement they just resolved.
        conflicts: state.conflicts.filter((key) => key !== action.key),
      };
    }
    case "discard":
      return { base: state.base, current: state.base, conflicts: [] };
    case "rebase": {
      // The server moved. Keys the person has NOT touched simply take the new
      // value — that is not a conflict, it is a refresh. Keys they have
      // touched, where the server's value also moved away from the base they
      // started from, are the real disagreements.
      const next = { ...state.current } as SuiteSettingsValues;
      const conflicts: SuiteSettingsKey[] = [];
      for (const key of SUITE_SETTINGS_KEYS) {
        const edited = !sameValue(state.current[key], state.base[key]);
        const serverMoved = !sameValue(action.live[key], state.base[key]);
        if (!edited) {
          (next as Record<string, unknown>)[key] = action.live[key];
          continue;
        }
        if (serverMoved && !sameValue(action.live[key], state.current[key])) {
          conflicts.push(key);
        }
      }
      return { base: action.live, current: next, conflicts };
    }
    case "commitSucceeded":
      return { base: action.live, current: action.live, conflicts: [] };
    default:
      return state;
  }
}

/** The keys whose value differs from the last saved one. */
export function dirtyKeys(draft: SuiteSettingsDraft): SuiteSettingsKey[] {
  return SUITE_SETTINGS_KEYS.filter(
    (key) => !sameValue(draft.current[key], draft.base[key])
  );
}

/**
 * Can this draft be saved at all?
 *
 * Two rules, both of which exist because the server would refuse anyway and a
 * refusal after the click is a worse way to learn it: a check that is
 * half-written is not a check, and a suite with no name is not addressable.
 */
export function canCommit(
  draft: SuiteSettingsDraft,
  areChecksValid: (list: Predicate[]) => boolean
): boolean {
  if (dirtyKeys(draft).length === 0) return false;
  if (draft.current.name.trim().length === 0) return false;
  return areChecksValid(draft.current.defaultPredicates);
}

/**
 * The mutation arguments for exactly the keys that changed.
 *
 * NULL SEMANTICS ARE PRESERVED EXACTLY as the per-control writers had them:
 * the backend distinguishes an omitted field (leave it) from `null` (clear
 * it), so a draft that sent `undefined` for a cleared judge would silently
 * keep the old one. Every clearing case is spelled out below rather than
 * folded into one `?? null`, because they are not all the same: an empty
 * predicate list clears, an empty NAME does not (it is refused above).
 */
export function toUpdateArgs(
  draft: SuiteSettingsDraft,
  suiteId: string,
  liveEnvironment?: {
    servers?: unknown[];
    serverBindings?: unknown;
  }
): Record<string, unknown> {
  const args: Record<string, unknown> = { suiteId };
  for (const key of dirtyKeys(draft)) {
    const value = draft.current[key];
    switch (key) {
      case "name":
        args.name = draft.current.name.trim();
        break;
      case "defaultPassCriteria":
        args.defaultPassCriteria = value ?? null;
        break;
      case "minIterations":
        args.minIterations = value ?? null;
        break;
      case "computerEnvironmentId":
        // The whole envelope, because that is the shape the mutation takes:
        // the pin lives inside `environment`, and sending the pin alone would
        // drop the server list beside it.
        args.environment = {
          servers: liveEnvironment?.servers ?? [],
          ...(liveEnvironment?.serverBindings !== undefined
            ? { serverBindings: liveEnvironment.serverBindings }
            : {}),
          ...(value ? { computerEnvironmentId: value } : {}),
        };
        break;
      case "defaultMatchOptions":
        args.defaultMatchOptions = value ?? null;
        break;
      case "defaultPredicates":
        args.defaultPredicates =
          (value as Predicate[]).length === 0 ? null : value;
        break;
      case "judgeConfig":
        args.judgeConfig = value ?? null;
        break;
      case "judgeRubric":
        args.judgeRubric = value ?? null;
        break;
    }
  }
  return args;
}

// ── Describing a change ─────────────────────────────────────────────────────

const ORDER_LABEL = new Map(ORDER_OPTIONS.map((o) => [o.value, o.label]));
const ARGS_LABEL = new Map(ARGS_OPTIONS.map((o) => [o.value, o.label]));

/** One row of the review dialog: what this key was, and what it will be. */
export type SuiteSettingsChange = {
  key: SuiteSettingsKey;
  label: string;
  before: string;
  after: string;
};

function describeMatchOptions(value: EvalMatchOptions | undefined): string {
  if (!value) return "Inherited";
  const parts: string[] = [];
  if (value.toolCallOrder)
    parts.push(ORDER_LABEL.get(value.toolCallOrder) ?? value.toolCallOrder);
  if (value.argumentMatching)
    parts.push(ARGS_LABEL.get(value.argumentMatching) ?? value.argumentMatching);
  if (value.maxExtraToolCalls !== undefined)
    parts.push(`at most ${value.maxExtraToolCalls} extra calls`);
  return parts.length > 0 ? parts.join(", ") : "Inherited";
}

function describePredicates(list: Predicate[]): string {
  if (list.length === 0) return "None";
  // The KINDS, counted — not the arguments. A review dialog listing every
  // predicate's operand would be unreadable at five checks and is not the
  // question the reader is asking, which is "what did I change".
  const counts = new Map<string, number>();
  for (const predicate of list) {
    const label =
      PREDICATE_KIND_LABELS[
        predicate.type as keyof typeof PREDICATE_KIND_LABELS
      ] ?? predicate.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(", ");
}

function describeJudge(value: EvalJudgeConfig | undefined): string {
  const goal = value?.goalCompletion;
  if (!goal || goal.enabled === false) return "Off";
  const bits = [goal.role === "gating" ? "Gating" : "Advisory"];
  if (goal.autoRun) bits.push("runs automatically");
  if (goal.judgeModel) bits.push(goal.judgeModel);
  if (goal.threshold !== undefined)
    bits.push(`threshold ${Math.round(goal.threshold * 100)}%`);
  return bits.join(", ");
}

/**
 * A human sentence for one key's before and after.
 *
 * TOTAL over `SuiteSettingsKey` by construction — the switch has no default,
 * so a new key is a compile error here rather than a row in the review dialog
 * that reads `[object Object] → [object Object]`.
 */
export function describeChange(
  key: SuiteSettingsKey,
  before: SuiteSettingsValues,
  after: SuiteSettingsValues
): SuiteSettingsChange {
  switch (key) {
    case "name":
      return {
        key,
        label: "Name",
        before: before.name || "Untitled",
        after: after.name || "Untitled",
      };
    case "defaultPassCriteria":
      return {
        key,
        label: "Minimum accuracy",
        before:
          before.defaultPassCriteria === undefined
            ? "Not set"
            : `${before.defaultPassCriteria.minimumPassRate}%`,
        after:
          after.defaultPassCriteria === undefined
            ? "Not set"
            : `${after.defaultPassCriteria.minimumPassRate}%`,
      };
    case "minIterations":
      return {
        key,
        label: "Minimum iterations",
        before: before.minIterations?.toString() ?? "Case default",
        after: after.minIterations?.toString() ?? "Case default",
      };
    case "computerEnvironmentId":
      return {
        key,
        label: "Computer environment",
        before: before.computerEnvironmentId ?? "None",
        after: after.computerEnvironmentId ?? "None",
      };
    case "defaultMatchOptions":
      return {
        key,
        label: "Tool calls",
        before: describeMatchOptions(before.defaultMatchOptions),
        after: describeMatchOptions(after.defaultMatchOptions),
      };
    case "defaultPredicates":
      return {
        key,
        label: "Checks",
        before: describePredicates(before.defaultPredicates),
        after: describePredicates(after.defaultPredicates),
      };
    case "judgeConfig":
      return {
        key,
        label: "Judge",
        before: describeJudge(before.judgeConfig),
        after: describeJudge(after.judgeConfig),
      };
    case "judgeRubric":
      return {
        key,
        label: "Judge criteria",
        before: summarizeRubric(before.judgeRubric),
        after: summarizeRubric(after.judgeRubric),
      };
  }
}

function summarizeRubric(rubric: EvalJudgeRubric | undefined): string {
  const criteria = rubric?.criteria ?? [];
  if (criteria.length === 0) return "None";
  return criteria.map((criterion) => criterion.label).join(", ");
}

/** Every change in this draft, in the sheet's own row order. */
export function describeDraft(
  draft: SuiteSettingsDraft
): SuiteSettingsChange[] {
  return dirtyKeys(draft).map((key) =>
    describeChange(key, draft.base, draft.current)
  );
}
