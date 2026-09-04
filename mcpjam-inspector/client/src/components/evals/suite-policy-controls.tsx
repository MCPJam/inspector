/**
 * The controls for a suite's verdict policy, and for when a run is valid.
 *
 * TWO POLICIES, NEVER BOTH ON SCREEN. A legacy suite is graded by
 * `minimumAccuracy` — one suite-wide PERCENT over `max(case.iterations,
 * minimumIterations)`. A v2 suite is graded per case by a `passThreshold`
 * FRACTION over that case's own `repetitions`, and decides validity first, so
 * an unmeasurable run reports inconclusive rather than failed. The two are not
 * convertible, and showing both would ask a reader to work out which one their
 * runs are actually decided by.
 *
 * FRACTIONS IN, PERCENTS ON SCREEN. Everything stored and everything sent is a
 * fraction in [0,1]; the only place a percent exists is in front of a person.
 * The threshold input therefore renders `Math.round(value * 100)` and drafts
 * `entered / 100`, and nothing else on this path divides by anything.
 */

import { useEffect, useId, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { SuiteVerdictPolicyDefaults } from "./suite-settings-draft";

/** The contract's defaults, shown as placeholders rather than written in. */
const VALIDITY_PLACEHOLDERS = {
  /**
   * No numeric default: an omitted floor is not "no minimum", it selects the
   * contract's coverage rule (every configured trial attempted, and at least
   * one gradeable trial). Saying "every trial" is the honest placeholder.
   */
  minEligibleTrials: "every trial",
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
 */
function PercentInput({
  label,
  value,
  placeholder,
  onCommit,
  ariaLabel,
}: {
  label?: string;
  value: number | undefined;
  placeholder?: string;
  onCommit: (fraction: number | undefined) => void;
  ariaLabel: string;
}) {
  const asPercent = value === undefined ? "" : String(Math.round(value * 100));
  const [text, setText] = useState(asPercent);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(asPercent);
  }, [asPercent, editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = text.trim();
    if (trimmed === "") {
      onCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setText(asPercent);
      return;
    }
    const clamped = Math.min(100, Math.max(0, parsed));
    onCommit(clamped / 100);
  };

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label ? <span className="min-w-[9rem]">{label}</span> : null}
      <span className="flex items-center gap-1">
        <input
          className="h-8 w-20 rounded-md border border-input bg-background px-2 text-right text-xs text-foreground"
          value={text}
          inputMode="decimal"
          placeholder={placeholder}
          aria-label={ariaLabel}
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setEditing(false);
              setText(asPercent);
              event.currentTarget.blur();
            }
          }}
        />
        <span aria-hidden>%</span>
      </span>
    </label>
  );
}

/**
 * The v2 policy controls: how many trials, and how many of them must pass.
 */
export function VerdictPolicyV2Controls({
  defaults,
  onChange,
}: {
  defaults: SuiteVerdictPolicyDefaults | undefined;
  onChange: (next: SuiteVerdictPolicyDefaults) => void;
}) {
  const repetitionsId = useId();
  // A v2 suite always HAS defaults; a suite mid-upgrade in the draft may not
  // yet, so the controls fall back to the same pair the upgrade proposes
  // rather than rendering blank inputs that write `NaN` on first touch.
  const current: SuiteVerdictPolicyDefaults = defaults ?? {
    repetitions: 1,
    passThreshold: 1,
  };
  return (
    <div className="space-y-2">
      <div data-setting-key="repetitions">
        <label
          className="flex items-center gap-2 text-xs text-muted-foreground"
          htmlFor={repetitionsId}
        >
          <span className="min-w-[9rem]">Repetitions</span>
          <select
            id={repetitionsId}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            value={current.repetitions}
            aria-label="Trials per case unless the case overrides it"
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
      <div data-setting-key="passThreshold">
        <PercentInput
          label="Pass threshold"
          value={current.passThreshold}
          ariaLabel="Fraction of a case's trials that must pass"
          onCommit={(fraction) =>
            onChange({ ...current, passThreshold: fraction ?? 0 })
          }
        />
      </div>
      <p className="text-[11px] text-muted-foreground/60">
        Each case is graded on its own trials. A case passes when at least this
        share of them passes.
      </p>
    </div>
  );
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
  const current: SuiteVerdictPolicyDefaults = defaults ?? {
    repetitions: 1,
    passThreshold: 1,
  };
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
        <span className="min-w-[9rem]">Minimum eligible trials</span>
        <input
          id={trialsId}
          className="h-8 w-20 rounded-md border border-input bg-background px-2 text-right text-xs text-foreground"
          inputMode="numeric"
          placeholder={VALIDITY_PLACEHOLDERS.minEligibleTrials}
          aria-label="Minimum gradeable trials before a run may be decided"
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
        label="Minimum completion"
        value={validity.minCompletionRate}
        placeholder={VALIDITY_PLACEHOLDERS.minCompletionRate}
        ariaLabel="Minimum share of trials that must have completed"
        onCommit={(fraction) => setValidity({ minCompletionRate: fraction })}
      />
      <PercentInput
        label="Maximum grader errors"
        value={validity.maxEvaluatorErrorRate}
        placeholder={VALIDITY_PLACEHOLDERS.maxEvaluatorErrorRate}
        ariaLabel="Maximum share of trials whose grader errored"
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

/**
 * The one-way upgrade.
 *
 * Offered only when the deployment and the caller can actually perform it —
 * the backend refuses otherwise, and a button whose only outcome is an error is
 * worse than no button. The proposed values are the LEGACY ones restated in v2
 * terms, so the review dialog shows a reader the bar they are moving to rather
 * than a version number.
 */
export function VerdictPolicyUpgradeButton({
  disabledReason,
  proposal,
  onUpgrade,
}: {
  /** Why it cannot be used, or `undefined` when it can. */
  disabledReason?: string;
  proposal: SuiteVerdictPolicyDefaults;
  onUpgrade: (defaults: SuiteVerdictPolicyDefaults) => void;
}) {
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        disabled={disabledReason !== undefined}
        onClick={() => onUpgrade(proposal)}
      >
        Switch to verdict policy v2
      </Button>
      <p className="text-[11px] text-muted-foreground/60">
        {disabledReason ??
          `Grades each case on its own trials: ${proposal.repetitions} repetition${
            proposal.repetitions === 1 ? "" : "s"
          }, ${Math.round(proposal.passThreshold * 100)}% threshold. One-way.`}
      </p>
    </div>
  );
}
