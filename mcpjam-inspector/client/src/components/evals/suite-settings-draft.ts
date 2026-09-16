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
import {
  EVAL_ITERATION_RULE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_LABELS,
  describeEvalPassCriterion,
  normalizeSuiteGatePolicy,
  type SuiteGatePolicyV1,
  evalExecutionBudgetsSchema,
} from "@mcpjam/sdk/contract";
import { ORDER_OPTIONS, ARGS_OPTIONS } from "./validators-section";
import type { EvalJudgeConfig, EvalJudgeRubric } from "./types";
import {
  describeGatePolicy,
  describeJudge,
  describePredicates,
  describeValidity,
  formatFraction,
  summarizeRubric,
} from "./suite-settings-summary";

export {
  describeGatePolicy,
  describeJudge,
  describeValidity,
  formatFraction,
  summarizeRubric,
} from "./suite-settings-summary";

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
  /**
   * The v2 verdict policy, drafted as a PAIR.
   *
   * `2` or absent — there is no other version and no way back, so this is the
   * one-way upgrade switch rather than a number anyone picks. It moves only
   * together with `verdictPolicyDefaults`, because a v2 suite with no defaults
   * is a suite the backend refuses to store.
   */
  verdictPolicyVersion: 2 | undefined;
  /**
   * FRACTIONS, whole-object.
   *
   * Written wholesale rather than field-by-field for the same reason the
   * backend stores it that way: `repetitions` without `passThreshold` cannot
   * answer what a case is graded against, so a partial value is not a partial
   * answer but an unanswerable one.
   */
  verdictPolicyDefaults: SuiteVerdictPolicyDefaults | undefined;
  /**
   * Stored quality-gate policy. `undefined` is "none"; a dirty clear
   * travels as `null` so the backend can distinguish omit from wipe.
   */
  gatePolicy: SuiteGatePolicyV1 | undefined;
  /**
   * AUTHORED execution budgets, one draft key per clock.
   *
   * Five keys rather than one object so a dirty badge names the clock that is
   * actually dirty — the same reason `policy` and `iterations` were split. They
   * are nonetheless SAVED as one object (see `toUpdateArgs`), because that is
   * the shape the mutation takes.
   *
   * `undefined` means un-authored, which resolves to the platform default. It
   * is not the same as a number that happens to equal the default: one is a
   * choice and the other is an inheritance, and the settings surface shows
   * them differently.
   */
  turnTimeoutMs: number | undefined;
  toolCallTimeoutMs: number | undefined;
  iterationTimeoutMs: number | undefined;
  runTimeoutMs: number | undefined;
  turnRetries: number | undefined;
};

/** The v2 defaults a case inherits. Fractions in [0,1], never percents. */
export type SuiteVerdictPolicyDefaults = {
  repetitions: number;
  passThreshold: number;
  validity?: {
    minEligibleTrials?: number;
    minCompletionRate?: number;
    maxEvaluatorErrorRate?: number;
  };
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
  "verdictPolicyVersion",
  "verdictPolicyDefaults",
  "gatePolicy",
  "turnTimeoutMs",
  "toolCallTimeoutMs",
  "iterationTimeoutMs",
  "runTimeoutMs",
  "turnRetries",
];

export type SuiteSettingsDraft = {
  /**
   * The suite these edits belong to.
   *
   * A draft is not a property of the sheet, it is a property of one SUITE, and
   * the two come apart the moment someone navigates: this component stays
   * mounted across suites, so without an identity the reducer happily carries
   * one suite's unsaved name onto the next one and the save writes it there.
   * `rebase` refuses to reconcile across a change of identity for that reason.
   */
  suiteId: string;
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
  /**
   * `value` may be the new value OR an updater over the current one.
   *
   * The updater form exists for the same reason `useState` has one, and it
   * matters more here: a control that appends (Add check) computed its next
   * value from whatever the last render closed over, so two clicks in one tick
   * would make the second overwrite the first. Resolving inside the reducer
   * reads the authoritative state instead.
   */
  | { type: "edit"; key: SuiteSettingsKey; value: unknown }
  | { type: "discard" }
  | { type: "rebase"; suiteId: string; live: SuiteSettingsValues }
  /**
   * `live` is what the save actually WROTE. `retained` names keys the save
   * could not carry (a legacy deployment that does not declare them); those
   * stay dirty so the person can save them once the backend catches up, which
   * is what the fallback's toast promises. `suiteId` guards the same hazard
   * `rebase` guards: a mutation that resolves after the person navigated must
   * not apply one suite's values to another's draft.
   */
  | {
      type: "commitSucceeded";
      suiteId: string;
      live: SuiteSettingsValues;
      retained?: SuiteSettingsKey[];
    };

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
  verdictPolicyVersion?: 2;
  verdictPolicyDefaults?: SuiteVerdictPolicyDefaults;
  gatePolicy?: SuiteGatePolicyV1;
  executionBudgets?: {
    turnTimeoutMs?: number;
    toolCallTimeoutMs?: number;
    iterationTimeoutMs?: number;
    runTimeoutMs?: number;
    turnRetries?: number;
  };
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
    verdictPolicyVersion: suite.verdictPolicyVersion,
    verdictPolicyDefaults: suite.verdictPolicyDefaults,
    gatePolicy: normalizeDraftGatePolicy(suite.gatePolicy),
    // Spread flat, deliberately: the stored object is optional and so is every
    // field in it, so `?.` on each is the only reading that distinguishes "no
    // budgets authored" from "budgets authored, this clock left to default".
    turnTimeoutMs: suite.executionBudgets?.turnTimeoutMs,
    toolCallTimeoutMs: suite.executionBudgets?.toolCallTimeoutMs,
    iterationTimeoutMs: suite.executionBudgets?.iterationTimeoutMs,
    runTimeoutMs: suite.executionBudgets?.runTimeoutMs,
    turnRetries: suite.executionBudgets?.turnRetries,
  };
}

/** Drop inactive `false` booleans; keep numeric `0`; empty becomes unset. */
export function normalizeDraftGatePolicy(
  policy: SuiteGatePolicyV1 | undefined,
): SuiteGatePolicyV1 | undefined {
  if (!policy) return undefined;
  const normalized = normalizeSuiteGatePolicy(policy);
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

export function initSuiteSettingsDraft(args: {
  suiteId: string;
  values: SuiteSettingsValues;
}): SuiteSettingsDraft {
  return {
    suiteId: args.suiteId,
    base: args.values,
    current: args.values,
    conflicts: [],
  };
}

export function suiteSettingsReducer(
  state: SuiteSettingsDraft,
  action: SuiteSettingsAction,
): SuiteSettingsDraft {
  switch (action.type) {
    case "edit": {
      // No draft key holds a function, so a callable `value` is unambiguously
      // the updater form rather than something to store.
      const resolved =
        typeof action.value === "function"
          ? (action.value as (previous: unknown) => unknown)(
              state.current[action.key],
            )
          : action.value;
      const current = {
        ...state.current,
        [action.key]: resolved,
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
      return {
        suiteId: state.suiteId,
        base: state.base,
        current: state.base,
        conflicts: [],
      };
    case "rebase": {
      // A DIFFERENT SUITE is not a rebase, it is a new draft.
      //
      // Reconciling across suites is how one suite's unsaved name ends up
      // proposed, and then written, onto another: every key the person edited
      // survives a rebase by design, and the identity is the only thing that
      // says those edits are not about this suite at all.
      if (action.suiteId !== state.suiteId) {
        return initSuiteSettingsDraft({
          suiteId: action.suiteId,
          values: action.live,
        });
      }
      // The server moved. Keys the person has NOT touched simply take the new
      // value — that is not a conflict, it is a refresh. Keys they have
      // touched, where the server's value also moved away from the base they
      // started from, are the real disagreements.
      const next = { ...state.current } as SuiteSettingsValues;
      // Carried forward: a conflict is unresolved until the PERSON resolves
      // it, by editing the key or discarding. Recomputing the whole set from
      // the new base drops a marker as soon as any unrelated field moves —
      // a colleague renaming the suite would clear the warning about the
      // threshold you both changed, and the next save would overwrite theirs
      // with no notice at all.
      const conflicts: SuiteSettingsKey[] = state.conflicts.filter((key) =>
        SUITE_SETTINGS_KEYS.includes(key),
      );
      for (const key of SUITE_SETTINGS_KEYS) {
        const edited = !sameValue(state.current[key], state.base[key]);
        const serverMoved = !sameValue(action.live[key], state.base[key]);
        if (!edited) {
          (next as Record<string, unknown>)[key] = action.live[key];
          continue;
        }
        if (
          serverMoved &&
          !sameValue(action.live[key], state.current[key]) &&
          !conflicts.includes(key)
        ) {
          conflicts.push(key);
        }
      }
      return { ...state, base: action.live, current: next, conflicts };
    }
    case "commitSucceeded": {
      // Same guard as `rebase`: an in-flight save that lands after a
      // navigation belongs to the suite it was started for, not this one.
      if (action.suiteId !== state.suiteId) return state;
      const retained = action.retained ?? [];
      if (retained.length === 0) {
        return {
          suiteId: state.suiteId,
          base: action.live,
          current: action.live,
          conflicts: [],
        };
      }
      // A retained key was never sent, so its SAVED value is still whatever it
      // was before, and the person's edit stays in `current` — which is what
      // keeps it dirty and retryable.
      const base = { ...action.live } as SuiteSettingsValues;
      const current = { ...action.live } as SuiteSettingsValues;
      for (const key of retained) {
        (base as Record<string, unknown>)[key] = state.base[key];
        (current as Record<string, unknown>)[key] = state.current[key];
      }
      return {
        suiteId: state.suiteId,
        base,
        current,
        conflicts: state.conflicts.filter((key) => retained.includes(key)),
      };
    }
    default:
      return state;
  }
}

/** The keys whose value differs from the last saved one. */
export function dirtyKeys(draft: SuiteSettingsDraft): SuiteSettingsKey[] {
  return SUITE_SETTINGS_KEYS.filter(
    (key) => !sameValue(draft.current[key], draft.base[key]),
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
  areChecksValid: (list: Predicate[]) => boolean,
): boolean {
  if (dirtyKeys(draft).length === 0) return false;
  if (draft.current.name.trim().length === 0) return false;
  if (outOfRangeBudgetKeys(draft.current).length > 0) return false;
  return areChecksValid(draft.current.defaultPredicates);
}

export type ExecutionBudgetDraftKey =
  | "turnTimeoutMs"
  | "toolCallTimeoutMs"
  | "iterationTimeoutMs"
  | "runTimeoutMs"
  | "turnRetries";

/**
 * Every clock the authored schema carries, taken from the schema rather than
 * listed again beside it.
 *
 * The union above is the spelling the rest of the module reads, but this list
 * is what the validation actually walks, so a sixth clock added to the
 * contract is bounded from the moment it exists. If it were ever a field with
 * no numeric bounds to read, it lands in the table below without them and
 * fails the test that walks it — which is the loud half of the same property.
 */
const EXECUTION_BUDGET_DRAFT_KEYS = Object.keys(
  evalExecutionBudgetsSchema.shape,
) as ExecutionBudgetDraftKey[];

/** Both platform bounds for one authored clock, in its stored unit. */
export type ExecutionBudgetBounds = { min: number; max: number };

/**
 * The PLATFORM bounds for each authored clock, read off the very schema the
 * route parses with.
 *
 * Both halves come from one place deliberately. Every clock here has a real
 * floor as well as a ceiling — a tool call may not be given under a second,
 * an iteration under thirty — and a table that carried only the ceiling let
 * the form offer a `0` the server was always going to refuse. A derived `max`
 * sitting beside a hand-written floor reads as single-sourced at a glance
 * while only half of it is.
 *
 * Taking the authored schema rather than lifting the ceilings table also
 * retires a name hazard: the iteration clock is `unitTimeoutMs` once resolved
 * but `iterationTimeoutMs` as authored, so a lift needed one hand-written
 * rename whose only symptom, if wrong, would be a check that silently passed.
 */
export const EXECUTION_BUDGET_DRAFT_BOUNDS: Readonly<
  Record<ExecutionBudgetDraftKey, ExecutionBudgetBounds>
> = Object.freeze(
  Object.fromEntries(
    EXECUTION_BUDGET_DRAFT_KEYS.map((key) => {
      const field = evalExecutionBudgetsSchema.shape[key].unwrap();
      return [key, { min: field.minValue, max: field.maxValue }];
    }),
  ) as Record<ExecutionBudgetDraftKey, ExecutionBudgetBounds>,
);

/**
 * Authored clocks the PLATFORM would refuse, so the save button can refuse
 * them first.
 *
 * Only the platform bounds, deliberately. An organization that lowered its own
 * ceiling is still enforced by the server, which names the field and the
 * bound; the client does not know that number and guessing it would either
 * block a legal value or promise one the server rejects.
 */
export function outOfRangeBudgetKeys(
  values: SuiteSettingsValues,
): ExecutionBudgetDraftKey[] {
  return EXECUTION_BUDGET_DRAFT_KEYS.filter((key) => {
    const value = values[key];
    if (value === undefined) return false;
    // Not a number at all is out of range too: a control that parsed junk into
    // NaN must not reach a save that would send it.
    if (!Number.isFinite(value)) return true;
    const bounds = EXECUTION_BUDGET_DRAFT_BOUNDS[key];
    return value < bounds.min || value > bounds.max;
  });
}

/**
 * The values as the SERVER will store them.
 *
 * One definition, used both to build the mutation arguments and to rebase the
 * draft after a successful save. Trimming in one place and rebasing with the
 * untrimmed value in another is how a person who typed `"  Name  "` ends up
 * looking at their own whitespace in the input while the server holds
 * something else.
 */
export function normalizeSuiteSettingsValues(
  values: SuiteSettingsValues,
): SuiteSettingsValues {
  return { ...values, name: values.name.trim() };
}

/**
 * What the draft should hold after a save, given what that save actually sent.
 *
 * Normalization applies ONLY to the dirty keys, because those are the only
 * ones the mutation carried. A suite whose stored name happens to have
 * surrounding whitespace, edited on some other row, must keep that name as the
 * server still holds it — normalizing it here would make the draft disagree
 * with the database about a field this save never touched.
 */
export function committedSuiteSettingsValues(
  draft: SuiteSettingsDraft,
): SuiteSettingsValues {
  const normalized = normalizeSuiteSettingsValues(draft.current);
  const out = { ...draft.current } as SuiteSettingsValues;
  for (const key of dirtyKeys(draft)) {
    (out as Record<string, unknown>)[key] = normalized[key];
  }
  return out;
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
  },
): Record<string, unknown> {
  const args: Record<string, unknown> = { suiteId };
  const normalized = normalizeSuiteSettingsValues(draft.current);
  for (const key of dirtyKeys(draft)) {
    const value = draft.current[key];
    switch (key) {
      case "name":
        args.name = normalized.name;
        break;
      case "defaultPassCriteria":
        // OMITTED when absent, never `null`: the mutation's validator is
        // `v.optional(passCriteriaValidator)` with no null member, so a `null`
        // here is an ArgumentValidationError that fails the whole batched save
        // — including the other settings in it. There is no control that
        // clears this today, which is the only reason the bug was unreachable.
        if (value !== undefined) args.defaultPassCriteria = value;
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
      case "verdictPolicyVersion":
      case "verdictPolicyDefaults":
        // OMITTED when absent, never `null`. The mutation's validators have no
        // null member for either, and the backend refuses a v2 version without
        // defaults — so there is no "clear the policy" to express here, and a
        // null would fail the whole batched save including the settings beside
        // it. There is no downgrade: v2 is one-way.
        if (value !== undefined) args[key] = value;
        break;
      case "gatePolicy":
        // NULL clears the stored policy. Omission would keep the old one.
        args.gatePolicy = value ?? null;
        break;
      case "turnTimeoutMs":
      case "toolCallTimeoutMs":
      case "iterationTimeoutMs":
      case "runTimeoutMs":
      case "turnRetries":
        // WHOLE-OBJECT, however few of the five are dirty. The mutation takes
        // `executionBudgets` as one value, so sending only the edited clock
        // would clear the other four — the stored object is replaced, not
        // merged. Assembling from `draft.current` sends every authored clock
        // whether or not it was touched this session.
        //
        // All five arms share this, and assigning the same object five times
        // is deliberate rather than guarded: it is idempotent, and a guard
        // would be one more thing to keep true.
        //
        // `null` when nothing is authored: that CLEARS back to the platform
        // defaults, which is what an author who emptied every field meant.
        // Omitting it would silently keep the budgets they just deleted.
        args.executionBudgets = authoredExecutionBudgets(draft.current);
        break;
    }
  }
  return args;
}

/**
 * The five draft clocks as the object the mutation stores, or `null` when the
 * author has left every one of them empty.
 */
function authoredExecutionBudgets(
  values: SuiteSettingsValues,
): Record<string, number> | null {
  const authored: Record<string, number> = {};
  if (values.turnTimeoutMs !== undefined)
    authored.turnTimeoutMs = values.turnTimeoutMs;
  if (values.toolCallTimeoutMs !== undefined)
    authored.toolCallTimeoutMs = values.toolCallTimeoutMs;
  if (values.iterationTimeoutMs !== undefined)
    authored.iterationTimeoutMs = values.iterationTimeoutMs;
  if (values.runTimeoutMs !== undefined)
    authored.runTimeoutMs = values.runTimeoutMs;
  if (values.turnRetries !== undefined)
    authored.turnRetries = values.turnRetries;
  return Object.keys(authored).length > 0 ? authored : null;
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

/** One label per clock, shared by the ledger and revision history. */
const EXECUTION_BUDGET_CHANGE_LABELS = {
  turnTimeoutMs: "Per-turn timeout",
  toolCallTimeoutMs: "Per-tool-call timeout",
  iterationTimeoutMs: "Per-iteration timeout",
  runTimeoutMs: "Whole-run timeout",
  turnRetries: "Model call retries",
} as const;

/**
 * A budget as a reader recognises it.
 *
 * "Platform default" rather than a number, because an un-authored clock IS the
 * default and printing the number would claim somebody chose it. Durations
 * render in the unit they were authored in — whole minutes stay minutes,
 * anything else falls back to seconds — so a 45s tool budget does not read as
 * "0.75 minutes".
 */
function describeBudgetValue(
  key: keyof typeof EXECUTION_BUDGET_CHANGE_LABELS,
  value: number | undefined,
): string {
  if (value === undefined) return "Platform default";
  if (key === "turnRetries")
    return `${value} ${value === 1 ? "retry" : "retries"}`;
  if (value % 60_000 === 0) {
    const minutes = value / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = value / 1000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function describeMatchOptions(value: EvalMatchOptions | undefined): string {
  if (!value) return "Inherited";
  const parts: string[] = [];
  if (value.toolCallOrder)
    parts.push(ORDER_LABEL.get(value.toolCallOrder) ?? value.toolCallOrder);
  if (value.argumentMatching)
    parts.push(
      ARGS_LABEL.get(value.argumentMatching) ?? value.argumentMatching,
    );
  if (value.maxExtraToolCalls !== undefined)
    parts.push(`at most ${value.maxExtraToolCalls} extra calls`);
  return parts.length > 0 ? parts.join(", ") : "Inherited";
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
  after: SuiteSettingsValues,
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
        // The SUITE-WIDE criterion, named from the shared grading vocabulary so
        // the review dialog, the settings row, revision history and the CLI all
        // say the same words about the same number.
        label: EVAL_PASS_CRITERION_SCOPE_LABELS.suiteWide,
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
        label: EVAL_ITERATION_RULE_LABELS.caseCountWithFloor,
        // "No minimum", not "Case default": the absent floor is the suite's
        // real state. "Case default" read as though some other default applied,
        // which is what the per-case rule does and this one does not.
        before: before.minIterations?.toString() ?? "No minimum",
        after: after.minIterations?.toString() ?? "No minimum",
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
        label: "Assertions",
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
        label: "Grading instructions",
        before: summarizeRubric(before.judgeRubric),
        after: summarizeRubric(after.judgeRubric),
      };
    case "verdictPolicyVersion":
      return {
        key,
        // "Pass criteria", not "Quality gate": this key records which
        // criterion decides the suite's runs, and the quality gate is the
        // separate comparison against a baseline. Three keys used to review
        // under two spellings of "Quality gate", so a reviewer reading a diff
        // could not tell which of the three had changed.
        label: "Pass criteria",
        before: describeCriterionScope(before),
        after: describeCriterionScope(after),
      };
    case "verdictPolicyDefaults":
      // The whole object, not just `.validity`: an edit to the count or the
      // threshold used to review as "Validity: Contract defaults → Contract
      // defaults", a row that named the wrong setting and showed no change.
      return {
        key,
        label: "Pass criteria and iterations",
        before: describePolicyDefaults(before.verdictPolicyDefaults),
        after: describePolicyDefaults(after.verdictPolicyDefaults),
      };
    case "turnTimeoutMs":
    case "toolCallTimeoutMs":
    case "iterationTimeoutMs":
    case "runTimeoutMs":
    case "turnRetries":
      return {
        key,
        label: EXECUTION_BUDGET_CHANGE_LABELS[key],
        before: describeBudgetValue(key, before[key]),
        after: describeBudgetValue(key, after[key]),
      };
    case "gatePolicy":
      return {
        key,
        // The one key that IS the quality gate.
        label: "Quality gate",
        before: describeGatePolicy(before.gatePolicy),
        after: describeGatePolicy(after.gatePolicy),
      };
  }
}

/**
 * Which criterion decides this suite, as the sentence a reviewer checks.
 *
 * Says what the bar IS, not which version names it. It read "Legacy 90% → v2:
 * 3 iterations, 90% threshold", where the two 90s are different numbers over
 * different populations — so the one row whose job is to show a reviewer that
 * the bar moved displayed a bar that looked unchanged. The sentences come from
 * the shared vocabulary's own composer, so both sides name their scope and
 * their population and cannot be mistaken for each other.
 */
function describeCriterionScope(values: SuiteSettingsValues): string {
  if (values.verdictPolicyVersion !== 2) {
    const rate = values.defaultPassCriteria?.minimumPassRate;
    if (rate === undefined) return "Not set";
    return describeEvalPassCriterion({
      scope: "suiteWide",
      thresholdPercent: rate,
      // The population and the empty-population rate the hosted run finalizer
      // uses, which is what decides a run configured this way.
      population: "iterations",
      emptyPopulationRate: 1,
    });
  }
  const defaults = values.verdictPolicyDefaults;
  if (!defaults) return "Not set";
  return describeEvalPassCriterion({
    scope: "perCase",
    threshold: defaults.passThreshold,
  });
}

/** Iterations, threshold, and the validity ceilings when any are set. */
function describePolicyDefaults(
  defaults: SuiteVerdictPolicyDefaults | undefined,
): string {
  if (!defaults) return "None";
  const parts = [
    `${defaults.repetitions} iteration${defaults.repetitions === 1 ? "" : "s"}`,
    `${formatFraction(defaults.passThreshold)} threshold`,
  ];
  if (defaults.validity) parts.push(`validity: ${describeValidity(defaults)}`);
  return parts.join(", ");
}

/** Every change in this draft, in the sheet's own row order. */
export function describeDraft(
  draft: SuiteSettingsDraft,
): SuiteSettingsChange[] {
  return dirtyKeys(draft).map((key) =>
    describeChange(key, draft.base, draft.current),
  );
}
