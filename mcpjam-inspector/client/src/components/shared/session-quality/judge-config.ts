/**
 * Product-neutral goal-completion judge config — the client mirror of the
 * backend `judgeConfigValidator` (mcpjam-backend `convex/lib/judgeConfig.ts`).
 * Shared by Evals (suite-level) and Swarms (journey-level) so both surfaces
 * drive the same `JudgesSection` UI and the same backend grader. Kept in sync
 * with the backend validator by hand, per the two-repo layout.
 *
 * The envelope carries `goalCompletion`, a reserved `groundedness` read slot
 * and `rubricChecks`. Groundedness is not authorable while execution is
 * unwired — keep it on the type so a PATCH merge cannot drop a stored slot,
 * and so the settings card can distinguish "absent" from "present". Every
 * writer carries the non-goal slots forward (`RESERVED_JUDGE_SLOTS`), so an
 * edit to one slot never erases another.
 */
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";

/** Authored goal-completion fields the settings draft may write. */
export type GoalCompletionJudgeSlot = {
  enabled?: boolean;
  judgeModel?: string;
  threshold?: number;
  /**
   * When true, the judge fires automatically as each run completes. Default
   * off so surfaces preserve cost-conscious behavior until they opt in.
   */
  autoRun?: boolean;
  /**
   * Whether this judge's verdict may DECIDE a trial, or only describe it.
   *
   * Absent means advisory, which is what every suite written before the gate
   * means — so a missing field can never be read as an accidental gate. The
   * backend refuses to store `gating` unless the suite is calibrated against
   * its current rubric and judge template, or an organization owner has
   * acknowledged the gap.
   *
   * `"required"` is the canonical spelling and `"gating"` its legacy one —
   * one value, two words. Storage said `"gating"` before the rename and says
   * `"required"` after it, so a reader takes both (`isRequiredRole`) and never
   * a literal.
   *
   * Mirrors `goalCompletionConfigFieldsValidator` in the backend's
   * `convex/lib/judgeConfig.ts`. Deliberately absent from
   * `GoalJudgeConfigOverride` below: the backend admits no per-case role, and
   * a per-run override may only lower to `"advisory"`.
   */
  role?: "advisory" | "gating" | "required";
  /**
   * Presentation severity. Legal only with `role: "advisory"`. Absent on
   * backends that predate C1, and omitted from defaults so the existing
   * goal-completion mirror stays byte-stable.
   */
  severity?: "warn";
};

/**
 * Reserved groundedness slot. Always advisory; writers refuse a newly
 * changed value while execution is `not_wired`. Present on the read type
 * so a stored slot survives an unrelated goal-completion edit.
 */
export type GroundednessJudgeSlot = {
  enabled?: boolean;
  judgeModel?: string;
  threshold?: number;
  role?: "advisory";
  severity?: "warn";
};

/**
 * One authored rubric-check question. Booleans are never authored: every
 * suite criterion already is one. Mirrors `rubricCheckQuestionValidator` in
 * the backend's `convex/lib/judgeConfig.ts`, and a pass line is required.
 */
export type RubricCheckQuestion = {
  id: string;
  kind: "choice" | "score";
  label: string;
  instructions: string;
  /** `choice` only: 2 to 20 options. */
  options?: Array<{ id: string; label: string; description?: string }>;
  /** `score` only: 2 to 10 ordered levels, lowest first. */
  levels?: string[];
  /** `choice`: the option ids that pass. `score`: the lowest passing level. */
  pass: { anyOf?: string[]; minLevel?: number };
};

/**
 * The rubric-checks slot: one typed question per suite criterion, plus the
 * questions above, answered by a classifier with a probability each. Always
 * advisory; it rides the goal-completion judge, so it grades exactly the
 * trials that judge grades.
 */
export type RubricChecksJudgeSlot = {
  enabled?: boolean;
  role?: "advisory";
  questions?: RubricCheckQuestion[];
};

/** Hand-mirrored from the backend's `convex/lib/judgeConfig.ts`. */
export const MAX_RUBRIC_CHECK_QUESTIONS = 10;
export const MIN_RUBRIC_CHECK_OPTIONS = 2;
export const MAX_RUBRIC_CHECK_OPTIONS = 20;
export const MIN_RUBRIC_CHECK_LEVELS = 2;
export const MAX_RUBRIC_CHECK_LEVELS = 10;
export const MAX_RUBRIC_CHECK_LABEL_LENGTH = 200;
export const MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH = 1000;

export type GoalJudgeConfig = {
  goalCompletion?: GoalCompletionJudgeSlot;
  groundedness?: GroundednessJudgeSlot;
  rubricChecks?: RubricChecksJudgeSlot;
};

/**
 * The slots a goal-completion edit must carry forward untouched. The backend
 * preserves an omitted slot too, but a client that DROPS a stored one sends an
 * envelope that looks like a deliberate clear to every other reader.
 */
export const RESERVED_JUDGE_SLOTS = ["groundedness", "rubricChecks"] as const;

/** Per-item judge override (per-case in Evals). Opt-out only in V1. */
export type GoalJudgeConfigOverride = {
  goalCompletion?: {
    enabled?: boolean;
  };
  rubricChecks?: {
    enabled?: boolean;
  };
};

/** Per-run exploration override; persists on the run for transparency. */
export type GoalJudgeRunOverride = {
  goalCompletion?: {
    judgeModel?: string;
    threshold?: number;
  };
};

/**
 * Defaults mirror the backend `GOAL_COMPLETION_DEFAULTS`. The backend is the
 * authority; these exist so the UI can render the managed default without a
 * round-trip and select it explicitly.
 *
 * Re-exported from `@/shared/judge-defaults` rather than re-typed here: the v1
 * suite DTO resolves `settings.judge` through the same mirror, so the API and
 * the UI cannot disagree about what "unset" means.
 */
export const MANAGED_DEFAULT_JUDGE_MODEL = GOAL_COMPLETION_DEFAULTS.judgeModel;
export const DEFAULT_JUDGE_THRESHOLD = GOAL_COMPLETION_DEFAULTS.threshold;
