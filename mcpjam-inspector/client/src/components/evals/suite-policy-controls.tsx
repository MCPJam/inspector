/**
 * The controls for a suite's grading policy: what must pass, how many times,
 * and what counts as enough evidence to decide.
 *
 * ONE CRITERION ON SCREEN, THE ONE THIS SUITE IS DECIDED BY. Its SCOPE says
 * which field and which units: a suite-wide criterion is one PERCENT over the
 * whole run, a per-case criterion is a FRACTION each case must meet over its
 * own iterations. Ten cases, nine always passing and one always failing: 90%
 * suite-wide passes that run and 0.9 per-case fails it. So the two are not one
 * number in two units, showing both would ask a reader to work out which
 * decides their runs, and there is no control here that converts one into the
 * other.
 *
 * NO VERSION, NO UPGRADE, NO SELECTOR. Every word on these controls comes from
 * `@mcpjam/sdk/contract`'s grading vocabulary, which has no member naming a
 * policy version — a suite-wide suite is measured differently, not obsolete.
 * Changing the scope is not an edit these controls can make; it is API-only
 * until an explicit scope-change operation ships in a follow-up.
 *
 * FRACTIONS IN, PERCENTS ON SCREEN. Everything stored and everything sent on
 * the per-case path is a fraction in [0,1]; the only place a percent exists is
 * in front of a person. The threshold input therefore renders
 * `Math.round(value * 100)` and drafts `entered / 100`, and nothing else on
 * this path divides by anything. The suite-wide path is the mirror image: the
 * stored field IS a percent and is never divided at all.
 */

import { useEffect, useId, useRef, useState } from "react";
import {
  EVAL_GRADING_VALIDITY_FIELD_LABELS,
  EVAL_ITERATION_RULE_HINTS,
  EVAL_ITERATION_RULE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_HINTS,
  EVAL_PASS_CRITERION_SCOPE_LABELS,
  casePassesNeeded,
} from "@mcpjam/sdk/contract";
import type { SuiteVerdictPolicyDefaults } from "./suite-settings-draft";

/** The contract's defaults, shown as placeholders rather than written in. */
const VALIDITY_PLACEHOLDERS = {
  /**
   * No numeric default: an omitted floor is not "no minimum", it selects the
   * contract's coverage rule (every configured trial attempted, and at least
   * one gradeable trial). Saying "every iteration" is the honest placeholder.
   */
  minEligibleTrials: "every iteration",
  minCompletionRate: "80%",
  maxEvaluatorErrorRate: "10%",
} as const;

/**
 * A percent field over a stored fraction.
 *
 * Keeps its own text while focused so a person can type "8" on the way to "80"
 * without the field rewriting itself to 8% under their cursor. Commits on blur
 * and on Enter, clamped into [0,1] — the backend refuses anything outside, and
 * a refusal after the save is a worse way to learn it.
 *
 * ONLY A CHANGE COMMITS. The field shows a ROUNDED percent, so a stored 0.855
 * reads "86"; if merely focusing and leaving committed what was on screen, the
 * suite would be rewritten to 0.86 by a reader who edited nothing. So the
 * typed number is compared with the stored one — the exact fraction, or the
 * percent the field already showed — and a match drafts nothing.
 *
 * A BLANK means two things, so the caller says which. On an optional field
 * (`required` unset) it commits `undefined`: the contract default. On a
 * required one it reverts to the stored value: there is no default to fall
 * back to, and committing 0 would turn an empty box into "accept anything".
 */
export function PercentInput({
  label,
  value,
  placeholder,
  onCommit,
  ariaLabel,
  required = false,
  disabled = false,
  aligned = false,
}: {
  label?: string;
  value: number | undefined;
  placeholder?: string;
  /** Receives `undefined` only when the field is optional and left blank. */
  onCommit: (fraction: number | undefined) => void;
  ariaLabel: string;
  /** A blank reverts to the stored value instead of committing `undefined`. */
  required?: boolean;
  disabled?: boolean;
  aligned?: boolean;
}) {
  const asPercent = value === undefined ? "" : String(Math.round(value * 100));
  const [text, setText] = useState(asPercent);
  const [editing, setEditing] = useState(false);
  // Escape reverts. It does so by blurring, and `blur()` runs the blur handler
  // synchronously against the text that was on screen, so the handler needs
  // to be told the blur is a revert before it can read anything.
  const revertOnBlur = useRef(false);
  useEffect(() => {
    if (!editing) setText(asPercent);
  }, [asPercent, editing]);

  const commit = () => {
    setEditing(false);
    if (revertOnBlur.current) {
      revertOnBlur.current = false;
      setText(asPercent);
      return;
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      if (required) {
        setText(asPercent);
        return;
      }
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setText(asPercent);
      return;
    }
    // Compared BEFORE clamping: "140" over a stored 100% is still an edit,
    // and the commit is what snaps the field back into range.
    const unchanged =
      value !== undefined &&
      (parsed / 100 === value || parsed === Math.round(value * 100));
    if (unchanged) {
      setText(asPercent);
      return;
    }
    onCommit(Math.min(100, Math.max(0, parsed)) / 100);
  };

  return (
    <label className={`flex items-center gap-2 text-xs text-muted-foreground ${aligned ? "justify-between" : ""}`}>
      {label ? <span className="min-w-[9rem]">{label}</span> : null}
      <span className="relative flex shrink-0 items-center gap-1">
        <input
          className={`h-8 ${aligned ? "w-40" : "w-20"} rounded-md border border-input bg-background px-2 text-right text-xs text-foreground`}
          value={text}
          inputMode="decimal"
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              revertOnBlur.current = true;
              event.currentTarget.blur();
            }
          }}
        />
        <span aria-hidden className={aligned ? "absolute left-full ml-2" : undefined}>%</span>
      </span>
    </label>
  );
}

/**
 * The per-case criterion's hint.
 *
 * Renamed from `QUALITY_GATE_THRESHOLD_HINT`: this sentence describes the PASS
 * CRITERION, and the quality gate is the separate comparison against a
 * baseline run. The old name is why one heading, one hint and one manifest row
 * all said "quality gate" about three different things.
 *
 * The sentence itself now comes from the shared grading vocabulary, so the app,
 * the CLI's flag help and the docs cannot drift on what a per-case threshold
 * measures. Store a fraction; the field next to this hint renders `%`.
 */
export const PASS_THRESHOLD_HINT = EVAL_PASS_CRITERION_SCOPE_HINTS.perCase;

/**
 * The PER-CASE criterion: the fraction of a case's own iterations that must
 * pass.
 *
 * Only the criterion. The count that used to sit above it moved to
 * {@link PerCaseIterationsControl}, because "what must pass" and "how many
 * times" are edited independently — raising the count does not move the bar —
 * and they are now two rows with two Edit affordances and two dirty badges.
 * They are still shown together in the arithmetic below, which is the one
 * place the two facts have to meet: how many passes a case actually needs.
 */
export function PerCasePassThresholdControl({
  defaults,
  onChange,
  aligned = false,
}: {
  defaults: SuiteVerdictPolicyDefaults | undefined;
  onChange: (next: SuiteVerdictPolicyDefaults) => void;
  aligned?: boolean;
}) {
  const current = perCaseDefaultsOrFallback(defaults);
  const passesNeeded = casePassesNeeded(
    current.repetitions,
    current.passThreshold,
  );
  return (
    <div className="space-y-2">
      <div data-setting-key="passThreshold">
        <PercentInput
          aligned={aligned}
          label={EVAL_PASS_CRITERION_SCOPE_LABELS.perCase}
          value={current.passThreshold}
          ariaLabel="Fraction of a case's iterations that must pass"
          required
          onCommit={(fraction) => {
            // A required field never commits a blank, so `undefined` cannot
            // reach here; the guard is so it can never be read as a 0 either.
            if (fraction !== undefined) {
              onChange({ ...current, passThreshold: fraction });
            }
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground/60">
        {PASS_THRESHOLD_HINT} A case with {current.repetitions} iteration
        {current.repetitions === 1 ? "" : "s"} needs {passesNeeded} pass
        {passesNeeded === 1 ? "" : "es"}.
      </p>
    </div>
  );
}

/**
 * The PER-CASE count: the suite default a case overrides.
 *
 * Labelled "Iterations per case", one word away from the suite-wide floor's
 * "Minimum iterations per case", and both words come from the shared
 * vocabulary. The difference is the whole point: this REPLACES a case's count
 * and the floor RAISES it, so a case at 7 resolves to 7 under a floor of 3 and
 * to 3 under a default of 3.
 */
export function PerCaseIterationsControl({
  defaults,
  onChange,
  aligned = false,
}: {
  defaults: SuiteVerdictPolicyDefaults | undefined;
  onChange: (next: SuiteVerdictPolicyDefaults) => void;
  aligned?: boolean;
}) {
  const repetitionsId = useId();
  const current = perCaseDefaultsOrFallback(defaults);
  return (
    <div className="space-y-2">
      <div data-setting-key="repetitions">
        <label
          className={`flex items-center gap-2 text-xs text-muted-foreground ${aligned ? "justify-between" : ""}`}
          htmlFor={repetitionsId}
        >
          <span className="min-w-[9rem]">
            {EVAL_ITERATION_RULE_LABELS.defaultCount}
          </span>
          <select
            id={repetitionsId}
            className={`h-8 ${aligned ? "w-40 shrink-0" : ""} rounded-md border border-input bg-background px-2 text-xs text-foreground`}
            value={current.repetitions}
            aria-label="Iterations per case unless the case overrides it"
            onChange={(event) =>
              onChange({ ...current, repetitions: Number(event.target.value) })
            }
          >
            {Array.from({ length: 100 }, (_, index) => index + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground/60">
        {EVAL_ITERATION_RULE_HINTS.defaultCount}
      </p>
    </div>
  );
}

/**
 * The stored per-case defaults, or the pair a blank draft falls back to.
 *
 * A per-case suite always HAS defaults. A draft can be missing them for one
 * render, and blank inputs there write `NaN` on first touch — so both controls
 * read through this rather than each inventing its own fallback and disagreeing
 * about it.
 */
function perCaseDefaultsOrFallback(
  defaults: SuiteVerdictPolicyDefaults | undefined,
): SuiteVerdictPolicyDefaults {
  return defaults ?? { repetitions: 1, passThreshold: 1 };
}

/**
 * The three validity ceilings.
 *
 * Every field is optional, and an EMPTY field is not "no minimum": omission
 * selects the contract's default, which the placeholders name. That is why
 * clearing a field drafts `undefined` rather than 0 — a zero here would be an
 * explicit "accept anything", which is the opposite of what a blank box looks
 * like it means.
 */
export function VerdictValidityControls({
  defaults,
  onChange,
}: {
  defaults: SuiteVerdictPolicyDefaults | undefined;
  onChange: (next: SuiteVerdictPolicyDefaults) => void;
}) {
  const trialsId = useId();
  const current = perCaseDefaultsOrFallback(defaults);
  const validity = current.validity ?? {};
  const setValidity = (
    patch: Partial<NonNullable<SuiteVerdictPolicyDefaults["validity"]>>,
  ) => {
    const merged = { ...validity, ...patch };
    // A validity object with nothing in it is not a policy; drop it so the
    // draft's "no change" and the server's "no ceilings" have one spelling.
    const cleaned = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    );
    onChange({
      ...current,
      ...(Object.keys(cleaned).length > 0
        ? { validity: cleaned }
        : { validity: undefined }),
    });
  };

  return (
    <div className="space-y-2">
      <label
        className="flex items-center gap-2 text-xs text-muted-foreground"
        htmlFor={trialsId}
      >
        <span className="min-w-[9rem]">
          {EVAL_GRADING_VALIDITY_FIELD_LABELS.minEligibleTrials}
        </span>
        <input
          id={trialsId}
          className="h-8 w-20 rounded-md border border-input bg-background px-2 text-right text-xs text-foreground"
          inputMode="numeric"
          placeholder={VALIDITY_PLACEHOLDERS.minEligibleTrials}
          aria-label="Minimum gradeable iterations before a run may be decided"
          value={validity.minEligibleTrials ?? ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const parsed = Number(raw);
            setValidity({
              minEligibleTrials:
                raw === "" || !Number.isFinite(parsed) || parsed < 1
                  ? undefined
                  : Math.floor(parsed),
            });
          }}
        />
      </label>
      <PercentInput
        label={EVAL_GRADING_VALIDITY_FIELD_LABELS.minCompletionRate}
        value={validity.minCompletionRate}
        placeholder={VALIDITY_PLACEHOLDERS.minCompletionRate}
        ariaLabel="Minimum share of iterations that must have completed"
        onCommit={(fraction) => setValidity({ minCompletionRate: fraction })}
      />
      <PercentInput
        label={EVAL_GRADING_VALIDITY_FIELD_LABELS.maxEvaluatorErrorRate}
        value={validity.maxEvaluatorErrorRate}
        placeholder={VALIDITY_PLACEHOLDERS.maxEvaluatorErrorRate}
        ariaLabel="Maximum share of iterations whose evaluator errored"
        onCommit={(fraction) =>
          setValidity({ maxEvaluatorErrorRate: fraction })
        }
      />
      <p className="text-[11px] text-muted-foreground/60">
        Leave a field empty to keep the contract default. A run that misses any
        of these is inconclusive, which is not the same as failed: it means the
        suite did not measure the server well enough to say.
      </p>
    </div>
  );
}

// ── Deliberately not here: the scope switch ──────────────────────────────────
//
// `VerdictPolicyUpgradeButton` used to sit at the bottom of the criterion row,
// offering "Switch to verdict policy v2" beside the threshold field. It is
// gone, and nothing replaces it here.
//
// It was the affordance for the one operation that must never look like a
// threshold edit. `minimumAccuracy` and `passThreshold` differ in SCOPE as well
// as units, so the switch re-decides every multi-case suite — the button's own
// proposal divided the stored percent by 100, which moves the bar for every
// suite with more than one case even though the number looks preserved. And it
// wrote its two draft fields into the ordinary batched settings save, where it
// rode along with unrelated edits and required an audit note only if the
// quality gate happened to be dirty in the same batch.
//
// Changing scope is API-only until an explicit scope-change operation ships;
// see the scope-change follow-up.
